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
import { z } from "zod";
import type { NotificationOutboxKind, Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import {
  PROVIDER_WINDOW_EXPIRED,
  providerWindowRefusal,
} from "@/lib/retry/provider-window";
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

const canonicalJson = (payload: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([a], [b]) => byCodePoint(a, b)),
    ),
  );

// Deterministic id from recipient(s) + workflow + canonical payload (or
// `dedupeKey` for callers that legitimately re-send an identical payload).
// Every Idempotency-Key the row sends is derived from it.
export function deriveTransactionId(
  workflowId: string,
  recipients: string | string[],
  payload: NovuPayload,
  dedupeKey?: string,
): string {
  const canonicalPayload = canonicalJson(payload);
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
 * one it is reported and `null` is returned, and nothing is sent.
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
 * Stages an audience as MULTI rows of at most {@link NOVU_BULK_LIMIT}
 * recipients in one insert, page `n` keyed `<dedupeKey>:page:<n>`. The
 * recipients must already be policy-filtered; every attempt rechecks them.
 */
export async function stagePages(
  tx: Pick<Tx, "notificationOutbox">,
  args: {
    workflowId: NovuWorkflowId;
    recipients: string[];
    payload: NovuPayload;
    dedupeKey: string;
    entityRef: string;
  },
): Promise<StagedTrigger[]> {
  if (args.recipients.length === 0) return [];
  const nextRetry = new Date(Date.now() + INLINE_ATTEMPT_LEASE_MS);
  const data = [];
  for (let i = 0; i < args.recipients.length; i += NOVU_BULK_LIMIT) {
    const recipients = args.recipients.slice(i, i + NOVU_BULK_LIMIT);
    const dedupeKey = `${args.dedupeKey}:page:${i / NOVU_BULK_LIMIT + 1}`;
    data.push({
      workflowId: args.workflowId,
      kind: "MULTI" as const,
      recipients,
      payload: args.payload as Prisma.InputJsonObject,
      transactionId: deriveTransactionId(
        args.workflowId,
        recipients,
        args.payload,
        dedupeKey,
      ),
      entityRef: args.entityRef,
      status: "PENDING" as const,
      nextRetryAt: nextRetry,
    });
  }
  return tx.notificationOutbox.createManyAndReturn({
    data,
    skipDuplicates: true,
    select: STAGED_SELECT,
  });
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
function describeNovuFailure(error: unknown): {
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
function reportTriggerFailure(
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

/**
 * Every write is conditional on an active status, so nothing overwrites SENT.
 * A write that narrows the recipients also requires the anchor the sent key
 * was built on, so a stale attempt cannot narrow a newer generation.
 */
async function settleRow(
  row: StagedTrigger,
  data: Prisma.NotificationOutboxUpdateManyMutationInput,
  anchor?: Date,
): Promise<void> {
  try {
    await prisma.notificationOutbox.updateMany({
      where: {
        id: row.id,
        status: { in: [...ACTIVE_STATUSES] },
        ...(anchor ? { firstAttemptAt: anchor } : {}),
      },
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

/** Event statuses Novu answers the same way on every retry. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "trigger_not_active",
  "no_workflow_active_steps_defined",
  "no_workflow_steps_defined",
  "no_tenant_found",
  "invalid_recipients",
]);

/** `status` stays a string so a value the SDK's closed enum lacks still parses. */
const bulkEventResultSchema = z.object({
  status: z.string(),
  error: z.array(z.string()).optional(),
});
type BulkEventResult = z.infer<typeof bulkEventResultSchema>;

/** What one bulk event's result means for its recipient; an unrecognised status retries. */
function bulkEventOutcome(
  result: BulkEventResult | undefined,
): "accepted" | "retry" | { terminal: string } {
  if (!result) return "retry";
  if (result.status === "processed") return "accepted";
  if (TERMINAL_EVENT_STATUSES.has(result.status)) {
    return { terminal: `novu_${result.status}` };
  }
  if (result.status !== "error") return "retry";
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

/**
 * The event results of a 2xx bulk response the SDK failed to validate. Any
 * other error is rethrown; an unreadable 2xx becomes a status-less error, so
 * its outcome counts as unknown and is retried, never marked SENT.
 */
function resultsOfRejectedBulkResponse(error: unknown): BulkEventResult[] {
  const { statusCode } = describeNovuFailure(error);
  if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
    throw error;
  }
  const body =
    typeof error === "object" && error !== null && "body" in error
      ? error.body
      : undefined;
  try {
    return z.array(bulkEventResultSchema).parse(JSON.parse(String(body)));
  } catch {
    throw new Error(`Novu bulk response unreadable (HTTP ${statusCode})`);
  }
}

/**
 * One bulk request's Idempotency-Key. The same anchor, recipients and wire
 * body always give the same key, so a resend after an unknown outcome is
 * deduped by Novu; a change to any of them gives a new key, never a reused
 * key with a different body (which Novu refuses with 422).
 */
export function bulkIdempotencyKey(
  transactionId: string,
  anchor: Date,
  recipients: string[],
  wire: { workflowId: string; payload: Record<string, unknown> },
): string {
  const digest = sha256Hex(
    `${anchor.toISOString()}|${wire.workflowId}|${recipients.join(",")}|${canonicalJson(wire.payload)}`,
  ).slice(0, 16);
  return `${transactionId}:bulk:${digest}`;
}

interface ChunkOutcome {
  accepted: string[];
  retry: string[];
  terminal: Array<{ recipient: string; reason: string }>;
  /** Novu's status for every event that was not accepted. */
  refusedStatuses: string[];
}

/**
 * One bulk request: an event per recipient under its stable per-recipient
 * transactionId. Throws when the outcome is unknown (no readable response).
 */
async function sendChunk(
  row: StagedTrigger,
  anchor: Date,
  chunk: string[],
): Promise<ChunkOutcome> {
  const wire = toWire(
    row.workflowId as NovuWorkflowId,
    row.payload as NovuPayload,
  );
  const transactionId = row.transactionId || row.id;
  const events = chunk.map((to) => ({
    workflowId: wire.workflowId,
    to,
    payload: wire.payload,
    transactionId: recipientTransactionId(transactionId, to),
  }));
  let results: BulkEventResult[];
  try {
    const response = await getNovuClient().triggerBulk(
      { events },
      bulkIdempotencyKey(transactionId, anchor, chunk, wire),
    );
    results = response.result;
  } catch (error) {
    results = resultsOfRejectedBulkResponse(error);
  }
  const outcome: ChunkOutcome = {
    accepted: [],
    retry: [],
    terminal: [],
    refusedStatuses: [],
  };
  chunk.forEach((recipient, index) => {
    const event = bulkEventOutcome(results[index]);
    if (event === "accepted") {
      outcome.accepted.push(recipient);
      return;
    }
    outcome.refusedStatuses.push(results[index]?.status ?? "missing");
    if (event === "retry") outcome.retry.push(recipient);
    else outcome.terminal.push({ recipient, reason: event.terminal });
  });
  return outcome;
}

async function sendBroadcast(row: StagedTrigger): Promise<void> {
  const wire = toWire(
    row.workflowId as NovuWorkflowId,
    row.payload as NovuPayload,
  );
  const transactionId = row.transactionId || row.id;
  await getNovuClient().triggerBroadcast(
    { name: wire.workflowId, payload: wire.payload, transactionId },
    transactionId,
  );
}

/**
 * Attempts wire delivery for one staged row. The first attempt filters a
 * targeted row by current bell policy and freezes that set together with the
 * `firstAttemptAt` anchor. Later attempts send exactly the frozen set under a
 * key built from it, so a resend after an unknown outcome is byte-identical
 * and Novu dedupes it. Only a definitive response changes the set (to the
 * recipients not yet accepted) and moves the anchor, which retires the old key.
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
  const clock = () => opts.now?.() ?? Date.now();
  const now = new Date(clock());
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
    narrow?: { recipients: string[]; anchor: Date },
  ): Promise<TriggerResult> => {
    await settleRow(
      row,
      {
        status: "DEAD_LETTER",
        attempts,
        lastError,
        ...(narrow ? { recipients: narrow.recipients } : {}),
      },
      narrow?.anchor,
    );
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
    providerWindowRefusal(at ? new Date(at) : null, now) !== null;
  if (pastReplayWindow(row.firstAttemptAt)) {
    return deadLetter(PROVIDER_WINDOW_EXPIRED, row.attempts);
  }

  let recipients = row.recipients;
  let anchor = row.firstAttemptAt ? new Date(row.firstAttemptAt) : null;
  if (!anchor) {
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
    try {
      const stamped = await prisma.notificationOutbox.updateMany({
        where: {
          id: row.id,
          status: { in: [...ACTIVE_STATUSES] },
          firstAttemptAt: null,
        },
        data: { firstAttemptAt: now, recipients },
      });
      if (stamped.count > 0) {
        anchor = now;
      } else {
        const current = await prisma.notificationOutbox.findUnique({
          where: { id: row.id },
          select: { status: true, firstAttemptAt: true, recipients: true },
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
        if (!current.firstAttemptAt) {
          return {
            success: false,
            error: "Outbox first-attempt claim lost",
            outcome: "PENDING",
          };
        }
        if (pastReplayWindow(current.firstAttemptAt)) {
          return deadLetter(PROVIDER_WINDOW_EXPIRED, row.attempts);
        }
        // Another attempt froze the set first; send exactly what it sends.
        anchor = new Date(current.firstAttemptAt);
        recipients = current.recipients;
      }
    } catch (error) {
      return { success: false, error: asError(error), outcome: "PENDING" };
    }
  }
  const sentAnchor = anchor;

  const attempts = opts.relay ? row.attempts + 1 : row.attempts;
  const exhaustedRetries = Boolean(opts.relay && attempts >= MAX_ATTEMPTS);
  const reportOpts = { exhaustedRetries, suppressSentry: opts.suppressSentry };
  // The response said who was accepted: keep the rest under a later anchor, so
  // the next attempt's key is new.
  const narrowTo = (narrowed: string[]) => ({
    recipients: narrowed,
    firstAttemptAt: new Date(Math.max(clock(), sentAnchor.getTime() + 1)),
  });
  const markSent = async (): Promise<TriggerResult> => {
    await settleRow(row, {
      status: "SENT",
      sentAt: now,
      attempts,
      lastError: null,
    });
    return { success: true, outcome: "SENT" };
  };
  const settleFailure = async (
    failure: Error | string,
    reason: string | null,
    narrowed?: string[],
  ): Promise<TriggerResult> => {
    const lastError = errorText(failure);
    if (reason || exhaustedRetries) {
      const dead = await deadLetter(
        lastError,
        attempts,
        narrowed && { recipients: narrowed, anchor: sentAnchor },
      );
      return { ...dead, success: false, error: failure };
    }
    const narrow = narrowed ? narrowTo(narrowed) : {};
    const guard = narrowed ? sentAnchor : undefined;
    if (opts.relay) {
      await settleRow(
        row,
        {
          status: "RETRY",
          attempts,
          nextRetryAt: nextRetryAt(attempts + 1, now),
          lastError,
          ...narrow,
        },
        guard,
      );
      Sentry.metrics?.count?.("notifications.outbox.transition", 1, {
        attributes: { status: "RETRY", workflowId: row.workflowId },
      });
      return { success: false, error: failure, outcome: "RETRY" };
    }
    await settleRow(row, { lastError, ...narrow }, guard);
    return { success: false, error: failure, outcome: "PENDING" };
  };

  if (row.kind === "BROADCAST") {
    try {
      await sendBroadcast(row);
      console.log(`[Novu] Triggered ${row.workflowId} for all subscribers`);
      return markSent();
    } catch (error) {
      const reported = reportTriggerFailure(
        error,
        row.workflowId,
        0,
        reportOpts,
      );
      if (reported.accepted) return markSent();
      return settleFailure(asError(error), reported.reason);
    }
  }

  // One bulk call per attempt keeps an attempt inside the drain's wave budget;
  // a row over the bulk limit sends its next chunk on the following attempt.
  const chunk = recipients.slice(0, NOVU_BULK_LIMIT);
  const unsent = recipients.slice(NOVU_BULK_LIMIT);
  let sent: ChunkOutcome;
  try {
    sent = await sendChunk(row, sentAnchor, chunk);
  } catch (error) {
    // Unknown outcome: the next attempt resends the same body under the same key.
    const reported = reportTriggerFailure(
      error,
      row.workflowId,
      chunk.length,
      reportOpts,
    );
    return settleFailure(asError(error), reported.reason);
  }

  const refused = sent.retry.length + sent.terminal.length;
  if (refused === 0) {
    console.log(
      `[Novu] Triggered ${row.workflowId} for ${chunk.length} subscribers`,
    );
    if (unsent.length === 0) return markSent();
    // Progress, not a failure: no attempt is spent and the rest is due now.
    await settleRow(row, { ...narrowTo(unsent), nextRetryAt: now }, sentAnchor);
    return { success: true, outcome: "PENDING" };
  }

  const remaining = [...sent.retry, ...unsent];
  const dropped = sent.terminal.map((t) => t.reason);
  const failure = new Error(
    `Novu refused ${refused} of ${chunk.length} bell events (${[
      ...new Set(sent.refusedStatuses),
    ].join(", ")})${
      dropped.length > 0 && remaining.length > 0
        ? `; dropped ${dropped.length} (${[...new Set(dropped)].join(", ")})`
        : ""
    }`,
  );
  // Terminal refusals are dropped; the row dead-letters only when nothing is left.
  const terminalReason = remaining.length === 0 ? (dropped[0] ?? null) : null;
  reportTriggerFailure(failure, row.workflowId, chunk.length, {
    ...reportOpts,
    terminalReason,
  });
  return settleFailure(
    failure,
    terminalReason,
    remaining.length > 0 ? remaining : sent.terminal.map((t) => t.recipient),
  );
}

export { MAX_ATTEMPTS as OUTBOX_MAX_ATTEMPTS };
