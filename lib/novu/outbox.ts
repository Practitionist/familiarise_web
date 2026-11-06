/**
 * #1654 — the Novu trigger outbox (closes #691 NTF-1).
 *
 * A trigger is one HTTPS call, and a function that freezes before it completes
 * loses the bell with no trace. So a trigger is first written as a
 * `NotificationOutbox` row where the business change commits (inside the
 * caller's transaction when it has one), then attempted inline under the
 * client's 5 s timeout, and drained by jobs/notifications/drain-notification-outbox.ts
 * when the inline attempt did not settle it. Same shape as lib/email/deliver.ts.
 */
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { TriggerEventResponseDto } from "@novu/api/models/components";
import type { NotificationOutboxKind, Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { isExpectedBellDeadLetter } from "@/lib/backoffice/queue-predicates";
import { nextRetryAt } from "@/lib/retry/backoff";
import { getNovuClient, isNovuConfigured } from "./client";
import { currentBellRecipients } from "./policy";
import { toWire } from "./templates";
import type { NovuWorkflowId } from "./templates/types";

/** Payload base type — all workflow payloads extend this. */
export type NovuPayload = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface TriggerResult {
  success: boolean;
  error?: Error | string;
  /** #1654 — set when the row was staged in a transaction and awaits `attemptTrigger` after commit. */
  staged?: StagedTrigger;
  /** #1654 — the row's status after the attempt, for the relay's counters. */
  outcome?: "SENT" | "PENDING" | "RETRY" | "DEAD_LETTER";
  /** The `lastError` a dead-lettered row was settled with. */
  deadLetterReason?: string;
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
  /** Scheduled floor; inline attempts before it leave the row for the drain. */
  notBefore: Date | null;
  /** Stamped once, just before the first provider call. */
  firstAttemptAt?: Date | null;
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
const ACTIVE_STATUSES = ["PENDING", "RETRY"] as const;
/** Novu's bulk endpoint takes at most 100 events per request. */
const NOVU_BULK_LIMIT = 100;

/**
 * Provider idempotency caches last 24 h; past this age since the first
 * attempt a retry could ring twice, so the row goes to review instead.
 */
export const PROVIDER_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * #1876 §4 — 60s lease window when staging a row due immediately so the
 * background cron drain does not race the caller's 5s inline attempt or
 * post-commit `attemptTrigger`.
 */
export const INLINE_ATTEMPT_LEASE_MS = 60_000;

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

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** One recipient's Novu transactionId inside a targeted row: stable across retries. */
export function recipientTransactionId(
  rowTransactionId: string,
  recipient: string,
): string {
  return `${rowTransactionId}:${sha256Hex(recipient).slice(0, 16)}`;
}

/** The row `transactionId` a Novu webhook's (possibly per-recipient) id belongs to. */
export function outboxTransactionIdOf(novuTransactionId: string): string {
  return (
    /^(.+:[0-9a-f]{32}):[0-9a-f]{16}$/.exec(novuTransactionId)?.[1] ??
    novuTransactionId
  );
}

const STAGED_SELECT = {
  id: true,
  workflowId: true,
  kind: true,
  recipients: true,
  payload: true,
  transactionId: true,
  attempts: true,
  status: true,
  notBefore: true,
  firstAttemptAt: true,
} as const;

/**
 * Phase one: the row. An upsert on `transactionId` with an empty update, so
 * staging the same notification twice (a replayed webhook, a re-run job)
 * returns the existing row instead of a unique violation that would roll back
 * the caller's transaction. Inside a transaction a failure propagates; outside
 * one it is reported and `null` is returned, and the caller sends directly.
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
 * unknown workflow, a rejected body, a bad key. 408, 409 and 429 are
 * transient, as is anything without a status (timeout, connection reset, 5xx).
 */
export function terminalTriggerReason(
  statusCode: number | undefined,
  novuMessage: string | undefined,
): string | null {
  if (statusCode === undefined) return null;
  if (statusCode < 400 || statusCode >= 500) return null;
  // 409: the same Idempotency-Key is still in flight at Novu.
  if (statusCode === 408 || statusCode === 409 || statusCode === 429) {
    return null;
  }
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
  opts?: {
    exhaustedRetries?: boolean;
    suppressSentry?: boolean;
    /** Set when the terminal cause came back in a bulk response body. */
    terminalReason?: string | null;
  },
): { accepted: boolean; reason: string | null } {
  const { statusCode, novuMessage, accepted } = describeNovuFailure(error);
  const reason = accepted
    ? null
    : (opts?.terminalReason ?? terminalTriggerReason(statusCode, novuMessage));
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

/** Every write is conditional on an active status, so nothing overwrites SENT. */
async function settleRow(
  row: StagedTrigger,
  data: Prisma.NotificationOutboxUpdateManyMutationInput,
): Promise<void> {
  try {
    await prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: { in: [...ACTIVE_STATUSES] } },
      data,
    });
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

const asError = (error: unknown): Error | string =>
  error instanceof Error ? error : String(error);

/** What one bulk event's result means for the row. */
function bulkEventOutcome(
  result: TriggerEventResponseDto | undefined,
): "accepted" | "retry" | { terminal: string } {
  if (!result) return "retry";
  if (result.status === "processed") return "accepted";
  if (result.status !== "error") return { terminal: `novu_${result.status}` };
  const message = (result.error ?? []).join("; ");
  // Novu refusing a transactionId it already holds means an earlier attempt delivered it.
  if (
    /transactionId/i.test(message) &&
    /unique|exist|duplicate/i.test(message)
  ) {
    return "accepted";
  }
  if (/workflow_not_found|not found/i.test(message)) {
    return { terminal: "workflow_not_found" };
  }
  return "retry";
}

type SendResult =
  | { accepted: true }
  | { accepted: false; terminalReason: string | null; message: string };

/**
 * Sends one outbox row. A targeted row goes out as one bulk event per allowed
 * recipient under a per-recipient transactionId, so a retry after partial
 * success never rings a delivered recipient twice.
 */
async function sendRow(
  row: StagedTrigger,
  recipients: string[],
): Promise<SendResult> {
  const novu = getNovuClient();
  const wire = toWire(
    row.workflowId as NovuWorkflowId,
    row.payload as NovuPayload,
  );
  const transactionId = row.transactionId || row.id;
  if (row.kind === "BROADCAST") {
    await novu.triggerBroadcast(
      { name: wire.workflowId, payload: wire.payload, transactionId },
      transactionId,
    );
    return { accepted: true };
  }
  const failures: string[] = [];
  let retryable = false;
  let terminalReason: string | null = null;
  for (let i = 0; i < recipients.length; i += NOVU_BULK_LIMIT) {
    const events = recipients.slice(i, i + NOVU_BULK_LIMIT).map((to) => ({
      workflowId: wire.workflowId,
      to,
      payload: wire.payload,
      transactionId: recipientTransactionId(transactionId, to),
    }));
    const idempotencyKey = `${transactionId}:bulk:${sha256Hex(
      events.map((event) => event.transactionId).join(","),
    ).slice(0, 16)}`;
    const { result } = await novu.triggerBulk({ events }, idempotencyKey);
    events.forEach((_, index) => {
      const outcome = bulkEventOutcome(result[index]);
      if (outcome === "accepted") return;
      failures.push(result[index]?.status ?? "missing");
      if (outcome === "retry") retryable = true;
      else terminalReason ??= outcome.terminal;
    });
  }
  if (failures.length === 0) return { accepted: true };
  return {
    accepted: false,
    terminalReason: retryable ? null : terminalReason,
    message: `Novu refused ${failures.length} of ${recipients.length} bell events (${[
      ...new Set(failures),
    ].join(", ")})`,
  };
}

/**
 * Attempts wire delivery for one staged row. A targeted row is rechecked
 * against current bell policy and sent only to recipients still allowed.
 * Inline attempts leave transient failures PENDING for the drain; relay
 * attempts advance backoff or dead-letter.
 */
export async function attemptTrigger(
  row: StagedTrigger,
  opts: { relay?: boolean; now?: () => number; suppressSentry?: boolean } = {},
): Promise<TriggerResult> {
  if (row.status === "SENT") return { success: true, outcome: "SENT" };
  if (row.status === "DEAD_LETTER") {
    return { success: true, outcome: "DEAD_LETTER" };
  }
  if (!isNovuConfigured()) {
    return { success: false, error: "Novu not configured", outcome: "PENDING" };
  }
  const now = new Date(opts.now?.() ?? Date.now());
  if (
    !opts.relay &&
    row.notBefore &&
    new Date(row.notBefore).getTime() > now.getTime()
  ) {
    return { success: true, staged: row, outcome: "PENDING" };
  }
  const deadLetter = async (
    lastError: string,
    attempts: number,
  ): Promise<TriggerResult> => {
    await settleRow(row, { status: "DEAD_LETTER", attempts, lastError });
    Sentry.metrics?.count?.("notifications.outbox.transition", 1, {
      attributes: { status: "DEAD_LETTER", workflowId: row.workflowId },
    });
    const expected = isExpectedBellDeadLetter(lastError);
    return {
      success: expected,
      ...(expected ? {} : { error: lastError }),
      outcome: "DEAD_LETTER",
      deadLetterReason: lastError,
    };
  };

  const pastReplayWindow = (at: Date | null | undefined) =>
    at
      ? now.getTime() - new Date(at).getTime() >= PROVIDER_REPLAY_WINDOW_MS
      : false;
  if (pastReplayWindow(row.firstAttemptAt)) {
    return deadLetter("review:provider_acceptance_unknown", row.attempts);
  }

  let recipients = row.recipients;
  if (row.kind !== "BROADCAST") {
    try {
      recipients = await currentBellRecipients(
        row.workflowId as NovuWorkflowId,
        row.recipients,
      );
    } catch (error) {
      return { success: false, error: asError(error), outcome: "PENDING" };
    }
    if (recipients.length === 0) {
      return deadLetter("policy:audience_revoked", row.attempts);
    }
  }

  if (!row.firstAttemptAt) {
    try {
      const stamped = await prisma.notificationOutbox.updateMany({
        where: {
          id: row.id,
          status: { in: [...ACTIVE_STATUSES] },
          firstAttemptAt: null,
        },
        data: { firstAttemptAt: now },
      });
      if (stamped.count === 0) {
        const current = await prisma.notificationOutbox.findUnique({
          where: { id: row.id },
          select: { status: true, firstAttemptAt: true },
        });
        if (!current) {
          return {
            success: false,
            error: "Outbox row not found",
            outcome: "PENDING",
          };
        }
        if (current.status === "SENT" || current.status === "DEAD_LETTER") {
          return { success: true, outcome: current.status };
        }
        if (pastReplayWindow(current.firstAttemptAt)) {
          return deadLetter("review:provider_acceptance_unknown", row.attempts);
        }
      }
    } catch (error) {
      return { success: false, error: asError(error), outcome: "PENDING" };
    }
  }

  const recipientCount = row.kind === "BROADCAST" ? 0 : recipients.length;
  const attempts = opts.relay ? row.attempts + 1 : row.attempts;
  const exhaustedRetries = Boolean(opts.relay && attempts >= MAX_ATTEMPTS);
  const markSent = async (): Promise<TriggerResult> => {
    await settleRow(row, {
      status: "SENT",
      sentAt: now,
      attempts,
      lastError: null,
    });
    return { success: true, outcome: "SENT" };
  };

  let failure: Error | string;
  let reason: string | null;
  try {
    const sent = await sendRow(row, recipients);
    if (sent.accepted) {
      console.log(
        `[Novu] Triggered ${row.workflowId} for ${recipientCount || "all"} subscribers`,
      );
      return markSent();
    }
    failure = new Error(sent.message);
    reason = reportTriggerFailure(failure, row.workflowId, recipientCount, {
      exhaustedRetries,
      suppressSentry: opts.suppressSentry,
      terminalReason: sent.terminalReason,
    }).reason;
  } catch (error) {
    const reported = reportTriggerFailure(
      error,
      row.workflowId,
      recipientCount,
      { exhaustedRetries, suppressSentry: opts.suppressSentry },
    );
    if (reported.accepted) return markSent();
    failure = asError(error);
    reason = reported.reason;
  }

  const lastError = errorText(failure);
  if (reason || exhaustedRetries) {
    const dead = await deadLetter(lastError, attempts);
    return { ...dead, success: false, error: failure };
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
    return { success: false, error: failure, outcome: "RETRY" };
  }
  await settleRow(row, { lastError });
  return { success: false, error: failure, outcome: "PENDING" };
}

export { MAX_ATTEMPTS as OUTBOX_MAX_ATTEMPTS };
