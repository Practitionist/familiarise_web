// Persist alongside the business change; provider I/O runs only after commit.
import { createHash } from "node:crypto";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import type { NotificationOutboxKind, Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { announcementDeliveryDecision } from "@/lib/announcements/delivery-policy";
import { nextRetryAt } from "@/lib/retry/backoff";
import { providerWindowRefusal } from "@/lib/retry/provider-window";
import { getNovuClient, isNovuConfigured } from "./client";
import { toWire } from "./templates";
import { novuWorkflowIdSchema, type NovuWorkflowId } from "./templates/types";
import { resolveRecipientBellPolicy } from "./policy";

/** Payload base type — all workflow payloads extend this. */
const novuPayloadSchema = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]),
);
export type NovuPayload = z.infer<typeof novuPayloadSchema>;

export interface TriggerResult {
  success: boolean;
  error?: Error | string;
  /** #1654 — set when the row was staged in a transaction and awaits `attemptTrigger` after commit. */
  staged?: StagedTrigger;
  /** #1654 — the row's status after the attempt, for the relay's counters. */
  outcome?: "SENT" | "PENDING" | "RETRY" | "DEAD_LETTER";
}

/** #1654 — the outbox row as `attemptTrigger` needs it. */
export interface StagedTrigger {
  id: string;
  workflowId: string;
  kind: NotificationOutboxKind;
  recipients: string[];
  payload: Prisma.JsonValue;
  transactionId: string;
  attempts: number;
  status: string;
  /** Quiet-hours floor; attempts before it leave the row for the drain. */
  notBefore: Date | null;
  createdAt?: Date | string;
}

export interface StageTriggerArgs {
  workflowId: NovuWorkflowId;
  kind: NotificationOutboxKind;
  recipients: string[];
  payload: NovuPayload;
  /** Lets a caller that legitimately re-sends an identical payload disambiguate. */
  dedupeKey?: string;
  entityRef?: string;
  /** The earliest instant the relay may send; null means as soon as possible. */
  notBefore?: Date;
  /** Stage inside the caller's transaction so a rollback takes the row too. */
  tx?: Pick<Tx, "notificationOutbox">;
}

const MAX_ATTEMPTS = 5;

/**
 * #1876 §4 — 60s lease window when staging a row due immediately so the
 * background cron drain does not race the caller's 5s inline attempt or
 * post-commit `attemptTrigger`.
 */
export const INLINE_ATTEMPT_LEASE_MS = 60_000;
export const INLINE_BELL_ATTEMPT_LIMIT = 5;

/**
 * #1876 §3 — ordered map of payload keys to entityRef prefixes so callers that
 * omit `entityRef` still populate `NotificationOutbox.entityRef` for triage.
 */
export const ENTITY_ID_KEYS: ReadonlyArray<
  readonly [key: string, prefix: string]
> = [
  ["appointmentId", "appointment"],
  ["paymentId", "payment"],
  ["refundId", "refund"],
  ["payoutId", "payout"],
  ["disputeId", "dispute"],
  ["ticketId", "ticket"],
  ["invoiceId", "invoice"],
  ["invoiceNumber", "invoice"],
  ["subscriptionId", "subscription"],
  ["trialId", "trial"],
  ["documentId", "document"],
  ["recordingId", "recording"],
  ["exportId", "export"],
  ["feedbackId", "feedback"],
  ["streamCallId", "call"],
  ["planId", "plan"],
  ["providerId", "provider"],
  ["organizationId", "org"],
] as const;

export function deriveEntityRef(payload: NovuPayload): string | null {
  for (const [key, prefix] of ENTITY_ID_KEYS) {
    const val = payload[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return `${prefix}:${val.trim()}`;
    }
  }
  return null;
}

// Code-point order, never localeCompare: collation-dependent sorting re-keyed
// mixed-case ids across runtimes and the id must be identical everywhere.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Deterministic id from recipient(s) + workflow + canonical payload (or
// `dedupeKey` for callers that legitimately re-send an identical payload). It is
// also sent as the Idempotency-Key: Novu does not dedupe on transactionId alone.
export function deriveTransactionId(
  workflowId: string,
  recipients: string | string[],
  payload: NovuPayload,
  dedupeKey?: string,
): string {
  const canonicalPayload = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([a], [b]) => byCodePoint(a, b)),
    ),
  );
  const recipientKey = Array.isArray(recipients)
    ? recipients.toSorted(byCodePoint).join(",")
    : recipients;
  const hash = createHash("sha256")
    .update(`${workflowId}|${recipientKey}|${dedupeKey ?? canonicalPayload}`)
    .digest("hex");
  return `${workflowId}:${hash.slice(0, 32)}`;
}

const STAGED_SELECT = {
  id: true,
  createdAt: true,
  workflowId: true,
  kind: true,
  recipients: true,
  payload: true,
  transactionId: true,
  attempts: true,
  status: true,
  notBefore: true,
} as const;

/**
 * Phase one: the row. An upsert on `transactionId` with an empty update, so
 * staging the same notification twice (a replayed webhook, a re-run job)
 * returns the existing row instead of a unique violation that would roll back
 * the caller's transaction. Inside a transaction a failure propagates; outside
 * one it is reported and `null` is returned. Delivery requires a durable row.
 */
export async function stageTrigger(
  args: StageTriggerArgs,
): Promise<StagedTrigger | null> {
  const transactionId = deriveTransactionId(
    args.workflowId,
    args.kind === "BROADCAST" ? [] : args.recipients,
    args.payload,
    args.dedupeKey,
  );
  const create = {
    workflowId: args.workflowId,
    kind: args.kind,
    recipients: args.recipients,
    payload: args.payload as Prisma.InputJsonObject,
    transactionId,
    entityRef: args.entityRef ?? deriveEntityRef(args.payload) ?? null,
    notBefore: args.notBefore ?? null,
    status: "PENDING" as const,
    nextRetryAt:
      args.notBefore ?? new Date(Date.now() + INLINE_ATTEMPT_LEASE_MS),
  };
  const query = {
    where: { transactionId },
    create,
    update: {},
    select: STAGED_SELECT,
  };
  if (args.tx) return args.tx.notificationOutbox.upsert(query);
  try {
    return await prisma.notificationOutbox.upsert(query);
  } catch (persistError) {
    console.error(`[Novu] ${args.workflowId} stage failed:`, persistError);
    Sentry.captureException(
      persistError instanceof Error
        ? persistError
        : new Error(String(persistError)),
      { tags: { subsystem: "novu", op: "stage" }, level: "warning" },
    );
    return null;
  }
}

/**
 * What the SDK actually told us about a failed trigger.
 *
 * `@novu/api` validates the RESPONSE against its own generated Zod schema and
 * throws `ResponseValidationError` before handing back the status. Its 422
 * schema requires an `errors` record, but the two 422s Novu documents for this
 * endpoint — an unknown or unpublished workflow (`workflow_not_found`) and an
 * idempotency key reused with a different body — both answer with `statusCode`
 * and `message` only. So all that reached Sentry was a ZodError about a field
 * of the SDK's own error envelope: the status and Novu's reason were both lost
 * (FAMILIARISE_WEB-1B). No published `@novu/api` relaxes that field (checked
 * through 3.19.1), so read the status off the error instead of chasing a bump.
 *
 * Duck-typed on `statusCode`: every `NovuError` subclass carries it, and the
 * class itself is not re-exported from the package root, so an `instanceof`
 * would mean deep-importing generated internals.
 */
export function describeNovuFailure(error: unknown): {
  statusCode?: number;
  /** Novu's own error text. Never the whole body — it can echo payload values. */
  novuMessage?: string;
  /** True when the SDK rejected a body Novu had already accepted. */
  accepted: boolean;
} {
  if (!error || typeof error !== "object") return { accepted: false };
  const { statusCode, body } = error as {
    statusCode?: unknown;
    body?: unknown;
  };
  if (typeof statusCode !== "number") return { accepted: false };

  let novuMessage: string | undefined;
  if (typeof body === "string" && body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body);
      const message =
        parsed && typeof parsed === "object"
          ? (parsed as { message?: unknown }).message
          : undefined;
      if (typeof message === "string") novuMessage = message.slice(0, 200);
    } catch {
      // Not JSON (an HTML gateway page); the status alone is the signal.
    }
  }

  return {
    statusCode,
    novuMessage,
    accepted: statusCode >= 200 && statusCode < 300,
  };
}

/**
 * The slug a terminal failure is fingerprinted on, or null when a retry may
 * help. Terminal is a 4xx Novu will answer the same way every time: an
 * unknown workflow, a rejected body, a bad key. 408 and 429 are transient,
 * as is anything without a status (timeout, connection reset, 5xx).
 */
export function terminalTriggerReason(
  statusCode: number | undefined,
  novuMessage: string | undefined,
): string | null {
  if (statusCode === undefined) return null;
  if (statusCode < 400 || statusCode >= 500) return null;
  if (statusCode === 408 || statusCode === 429) return null;
  if (novuMessage && /workflow_not_found|not found/i.test(novuMessage)) {
    return "workflow_not_found";
  }
  return `http_${statusCode}`;
}

/**
 * #1876 §2 — Construct a clean Error for Sentry without `NovuError.body` or
 * `ResponseValidationError.rawValue`, which carry echoed subscriber/payload PII.
 */
function sanitizeNovuErrorForSentry(
  error: unknown,
  statusCode?: number,
  novuMessage?: string,
): Error {
  if (error instanceof Error && !("body" in error) && !("rawValue" in error)) {
    return error;
  }
  const baseMessage =
    novuMessage ?? (error instanceof Error ? error.message : String(error));
  const clean = new Error(
    statusCode !== undefined && !baseMessage.includes(String(statusCode))
      ? `Novu HTTP ${statusCode}: ${baseMessage}`
      : baseMessage,
  );
  if (error instanceof Error) {
    clean.name = error.name;
    clean.stack = error.stack;
  }
  return clean;
}

/**
 * One report shape for every `novu.trigger` failure. `accepted` means the
 * notification is already queued at Novu and only the SDK's response parsing
 * failed, so it is an expected outcome rather than a lost notification.
 */
export function reportTriggerFailure(
  error: unknown,
  workflowId: string,
  recipientCount: number,
  opts?: { exhaustedRetries?: boolean; suppressSentry?: boolean },
): { accepted: boolean; reason: string | null } {
  const { statusCode, novuMessage, accepted } = describeNovuFailure(error);
  const reason = accepted
    ? null
    : terminalTriggerReason(statusCode, novuMessage);
  const isDeadLetter = Boolean(
    !accepted && (reason !== null || opts?.exhaustedRetries),
  );
  console.error(`[Novu] Failed to trigger ${workflowId}:`, {
    workflowId,
    statusCode,
    novuMessage,
    recipientCount,
    accepted,
  });
  if (!opts?.suppressSentry) {
    Sentry.captureException(
      sanitizeNovuErrorForSentry(error, statusCode, novuMessage),
      {
        tags: {
          subsystem: "novu",
          op: "trigger",
          expected: String(accepted),
          ...(isDeadLetter ? { outbox_dead_letter: "true" } : {}),
        },
        level: isDeadLetter ? "error" : "warning",
        ...(reason
          ? { fingerprint: ["novu-trigger-terminal", reason] }
          : opts?.exhaustedRetries
            ? { fingerprint: ["novu-trigger-exhausted", workflowId] }
            : {}),
        extra: {
          workflowId,
          statusCode,
          novuMessage,
          recipientCount,
          ...(opts?.exhaustedRetries ? { exhaustedRetries: true } : {}),
        },
      },
    );
  }
  return { accepted, reason };
}

async function settleRow(
  row: StagedTrigger,
  data: Prisma.NotificationOutboxUpdateInput,
): Promise<void> {
  try {
    await prisma.notificationOutbox.update({ where: { id: row.id }, data });
  } catch (updateError) {
    console.error(`[Novu] ${row.workflowId} row update failed:`, updateError);
  }
}

function errorText(error: unknown): string {
  const { statusCode, novuMessage } = describeNovuFailure(error);
  const base = error instanceof Error ? error.message : String(error);
  return [statusCode && `HTTP ${statusCode}`, novuMessage ?? base]
    .filter(Boolean)
    .join(": ")
    .slice(0, 500);
}

/** Sends one outbox row through the Novu client under its deterministic transactionId. */
async function sendRow(row: StagedTrigger): Promise<void> {
  const novu = getNovuClient();
  const wire = toWire(
    novuWorkflowIdSchema.parse(row.workflowId),
    novuPayloadSchema.parse(row.payload),
  );
  const transactionId = row.transactionId || row.id;
  if (row.kind === "BROADCAST") {
    await novu.triggerBroadcast(
      { name: wire.workflowId, payload: wire.payload, transactionId },
      transactionId,
    );
    return;
  }
  await novu.trigger(
    {
      workflowId: wire.workflowId,
      to: row.kind === "SINGLE" ? row.recipients[0] : row.recipients,
      payload: wire.payload,
      transactionId,
    },
    transactionId,
  );
}

/**
 * Attempts wire delivery for one staged row. Inline attempts leave transient
 * failures PENDING for the drain; relay attempts advance backoff or dead-letter.
 */
export async function attemptTrigger(
  row: StagedTrigger,
  opts: { relay?: boolean; now?: () => number; suppressSentry?: boolean } = {},
): Promise<TriggerResult> {
  if (row.status === "SENT") return { success: true, outcome: "SENT" };
  if (row.status === "DEAD_LETTER")
    return { success: true, outcome: "DEAD_LETTER" };
  if (!isNovuConfigured()) {
    return { success: false, error: "Novu not configured", outcome: "PENDING" };
  }
  const now = new Date(opts.now?.() ?? Date.now());
  if (row.notBefore && new Date(row.notBefore).getTime() > now.getTime()) {
    return { success: true, staged: row, outcome: "PENDING" };
  }
  if (row.workflowId === "general-announcement") {
    try {
      const decision = await announcementDeliveryDecision(
        row.payload,
        now,
        prisma,
      );
      if (decision && "skip" in decision) {
        await settleRow(row, {
          status: "DEAD_LETTER",
          lastError: decision.skip,
        });
        return {
          success: decision.skip !== "announcement:invalid_context",
          ...(decision.skip === "announcement:invalid_context"
            ? { error: decision.skip }
            : {}),
          outcome: "DEAD_LETTER",
        };
      }
      if (decision && "notBefore" in decision) {
        await settleRow(row, {
          notBefore: decision.notBefore,
          nextRetryAt: decision.notBefore,
        });
        return { success: true, outcome: "PENDING" };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : String(error),
        outcome: "PENDING",
      };
    }
  }
  const windowRefusal = providerWindowRefusal(
    row.createdAt,
    now,
    row.notBefore,
  );
  if (windowRefusal) {
    await settleRow(row, {
      status: "DEAD_LETTER",
      lastError: windowRefusal,
    });
    return { success: false, error: windowRefusal, outcome: "DEAD_LETTER" };
  }
  const workflow = novuWorkflowIdSchema.safeParse(row.workflowId);
  if (
    !workflow.success ||
    !novuPayloadSchema.safeParse(row.payload).success ||
    (row.kind !== "BROADCAST" && row.recipients.length === 0)
  ) {
    await settleRow(row, {
      status: "DEAD_LETTER",
      lastError: "notification:invalid_context",
    });
    return {
      success: false,
      error: "notification:invalid_context",
      outcome: "DEAD_LETTER",
    };
  }
  if (row.kind !== "BROADCAST") {
    try {
      const policy = await resolveRecipientBellPolicy(
        workflow.data,
        row.recipients,
        { deferrable: false },
      );
      if (policy.allowedRecipients.length !== row.recipients.length) {
        const partial = policy.allowedRecipients.length > 0;
        const reason = partial
          ? "review:audience_changed"
          : "recipient:audience_changed";
        await settleRow(row, {
          status: "DEAD_LETTER",
          lastError: reason,
        });
        return {
          success: !partial,
          ...(partial ? { error: reason } : {}),
          outcome: "DEAD_LETTER",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : String(error),
        outcome: "PENDING",
      };
    }
  }
  const recipientCount = row.kind === "BROADCAST" ? 0 : row.recipients.length;
  const attempts = opts.relay ? row.attempts + 1 : row.attempts;
  try {
    await sendRow(row);
    console.log(
      `[Novu] Triggered ${row.workflowId} for ${recipientCount || "all"} subscribers`,
    );
    await settleRow(row, {
      status: "SENT",
      sentAt: now,
      attempts,
      lastError: null,
    });
    return { success: true, outcome: "SENT" };
  } catch (error) {
    const exhaustedRetries = Boolean(opts.relay && attempts >= MAX_ATTEMPTS);
    const { accepted, reason } = reportTriggerFailure(
      error,
      row.workflowId,
      recipientCount,
      { exhaustedRetries, suppressSentry: opts.suppressSentry },
    );
    if (accepted) {
      await settleRow(row, {
        status: "SENT",
        sentAt: now,
        attempts,
        lastError: null,
      });
      return { success: true, outcome: "SENT" };
    }
    const lastError = errorText(error);
    const failure = {
      success: false as const,
      error: error instanceof Error ? error : String(error),
    };
    if (reason || exhaustedRetries) {
      await settleRow(row, { status: "DEAD_LETTER", attempts, lastError });
      Sentry.metrics?.count?.("notifications.outbox.transition", 1, {
        attributes: { status: "DEAD_LETTER", workflowId: row.workflowId },
      });
      return { ...failure, outcome: "DEAD_LETTER" };
    }
    if (opts.relay) {
      await settleRow(row, {
        status: "RETRY",
        attempts,
        nextRetryAt: nextRetryAt(attempts + 1, now),
        lastError,
      });
      Sentry.metrics?.count?.("notifications.outbox.transition", 1, {
        attributes: { status: "RETRY", workflowId: row.workflowId },
      });
      return { ...failure, outcome: "RETRY" };
    }
    await settleRow(row, { lastError });
    return { ...failure, outcome: "PENDING" };
  }
}

export { MAX_ATTEMPTS as OUTBOX_MAX_ATTEMPTS };
