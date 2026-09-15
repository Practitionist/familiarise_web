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
import type { NotificationOutboxKind, Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { nextRetryAt } from "@/lib/retry/backoff";
import { getNovuClient, isNovuConfigured } from "./client";
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

// Code-point order, never localeCompare: collation-dependent sorting re-keyed
// mixed-case ids across runtimes and the id must be identical everywhere.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Deterministic transactionId so app-level retries can't double-notify: Novu
// rejects a repeated transactionId. Derived from recipient(s) + workflow +
// canonical payload (the payloads carry the entity ids). `dedupeKey` lets a
// caller that legitimately re-sends an identical payload (e.g. 24h vs 1h
// appointment reminders) disambiguate the sends.
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
  workflowId: true,
  kind: true,
  recipients: true,
  payload: true,
  transactionId: true,
  attempts: true,
  status: true,
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
    entityRef: args.entityRef ?? null,
    notBefore: args.notBefore ?? null,
    status: "PENDING" as const,
    nextRetryAt: new Date(),
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
 * One report shape for every `novu.trigger` failure. `accepted` means the
 * notification is already queued at Novu and only the SDK's response parsing
 * failed, so it is an expected outcome rather than a lost notification.
 */
export function reportTriggerFailure(
  error: unknown,
  workflowId: string,
  recipientCount: number,
): { accepted: boolean; reason: string | null } {
  const { statusCode, novuMessage, accepted } = describeNovuFailure(error);
  const reason = accepted
    ? null
    : terminalTriggerReason(statusCode, novuMessage);
  // Never pass the raw SDK error: `NovuError.body` is the submitted payload
  // echoed back on validation failures, so it can carry notification PII.
  console.error(`[Novu] Failed to trigger ${workflowId}:`, {
    workflowId,
    statusCode,
    novuMessage,
    recipientCount,
    accepted,
  });
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    {
      tags: {
        subsystem: "novu",
        op: "trigger",
        expected: String(accepted),
      },
      // #1654 — a terminal reason pages once per reason; a transient one is
      // a warning the relay will retry.
      level: reason ? "error" : "warning",
      ...(reason && { fingerprint: ["novu-trigger-terminal", reason] }),
      extra: { workflowId, statusCode, novuMessage, recipientCount },
    },
  );
  return { accepted, reason };
}

// Best-effort: the send outcome is already decided, and the relay re-reads the
// row, so losing this write costs a re-trigger Novu dedupes on transactionId.
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

/** The wire call for one row: the existing `toWire` mapping and client. */
async function sendRow(row: StagedTrigger): Promise<void> {
  const novu = getNovuClient();
  const wire = toWire(
    row.workflowId as NovuWorkflowId,
    row.payload as NovuPayload,
  );
  if (row.kind === "BROADCAST") {
    await novu.triggerBroadcast({
      name: wire.workflowId,
      payload: wire.payload,
      transactionId: row.transactionId,
    });
    return;
  }
  await novu.trigger({
    workflowId: wire.workflowId,
    to: row.kind === "SINGLE" ? row.recipients[0] : row.recipients,
    payload: wire.payload,
    transactionId: row.transactionId,
  });
}

/**
 * Phase two: one wire attempt for a staged row, under the client's 5 s timeout
 * (lib/novu/client.ts). Success → SENT; a 2xx the SDK could not parse → SENT
 * (Novu has it); terminal → DEAD_LETTER and a page; timeout, 5xx or a network
 * failure → left PENDING with `lastError` for the relay. Never throws.
 *
 * `relay` is the drain's mode: the attempt counts against the row's five,
 * a transient failure schedules RETRY on the shared backoff ladder, and the
 * last failure dead-letters. The inline attempt spends none of that, so the
 * ladder starts from the relay's first try.
 */
export async function attemptTrigger(
  row: StagedTrigger,
  opts: { relay?: boolean; now?: () => number } = {},
): Promise<TriggerResult> {
  if (row.status === "SENT") return { success: true, outcome: "SENT" };
  if (!isNovuConfigured()) {
    return { success: false, error: "Novu not configured", outcome: "PENDING" };
  }
  const now = new Date(opts.now?.() ?? Date.now());
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
    // A 2xx the SDK could not parse still queued the notification; reporting it
    // as a failed send made callers retry a send Novu had already accepted.
    const { accepted, reason } = reportTriggerFailure(
      error,
      row.workflowId,
      recipientCount,
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
    if (reason || (opts.relay && attempts >= MAX_ATTEMPTS)) {
      await settleRow(row, { status: "DEAD_LETTER", attempts, lastError });
      return { ...failure, outcome: "DEAD_LETTER" };
    }
    if (opts.relay) {
      await settleRow(row, {
        status: "RETRY",
        attempts,
        nextRetryAt: nextRetryAt(attempts + 1, now),
        lastError,
      });
      return { ...failure, outcome: "RETRY" };
    }
    await settleRow(row, { lastError });
    return { ...failure, outcome: "PENDING" };
  }
}

export { MAX_ATTEMPTS as OUTBOX_MAX_ATTEMPTS };
