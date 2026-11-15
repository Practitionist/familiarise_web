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
import { currentBellRecipients, unerasedRecipients } from "./policy";
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
  /** Set when terminally refused recipients were split into their own DEAD_LETTER row. */
  terminalSplit?: string;
  /** Set when Novu answered 429; the relay starts no further wave this tick. */
  retryAfterMs?: number;
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
  /** Stamped just before a generation's first provider call; null while none is outstanding. */
  firstAttemptAt?: Date | null;
  entityRef?: string | null;
  lastError?: string | null;
  createdAt?: Date | string;
}

export interface StageTriggerArgs {
  workflowId: NovuWorkflowId;
  kind: "SINGLE" | "MULTI";
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

/** The row `transactionId` a Novu activity's (possibly per-recipient) id belongs to. */
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
  entityRef: true,
  lastError: true,
} as const;

/** The PENDING row a trigger is staged as, keyed by its deterministic `transactionId`. */
function stagedRowData(args: Omit<StageTriggerArgs, "tx">) {
  return {
    workflowId: args.workflowId,
    kind: args.kind,
    recipients: args.recipients,
    payload: args.payload as Prisma.InputJsonObject,
    transactionId: deriveTransactionId(
      args.workflowId,
      args.recipients,
      args.payload,
      args.dedupeKey,
    ),
    entityRef: args.entityRef ?? deriveEntityRef(args.payload) ?? null,
    notBefore: args.notBefore ?? null,
    status: "PENDING" as const,
    nextRetryAt:
      args.notBefore ?? new Date(Date.now() + INLINE_ATTEMPT_LEASE_MS),
  };
}

/**
 * Stages already policy-filtered triggers inside `tx` in one insert. A row
 * already staged under the same `transactionId` is kept and not returned, so
 * the relay, not the caller's flush, settles it.
 */
export async function stageTriggerBatch(
  tx: Pick<Tx, "notificationOutbox">,
  rows: ReadonlyArray<Omit<StageTriggerArgs, "tx">>,
): Promise<StagedTrigger[]> {
  if (rows.length === 0) return [];
  return tx.notificationOutbox.createManyAndReturn({
    data: rows.map(stagedRowData),
    skipDuplicates: true,
    select: STAGED_SELECT,
  });
}

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
  const create = stagedRowData(args);
  const query = {
    where: { transactionId: create.transactionId },
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
 * A write after a definitive response also requires the anchor the sent key
 * was built on, so a stale attempt cannot settle a newer generation. A split
 * dead-letter row is inserted in the same transaction, only when that write
 * applied. Returns whether the write applied.
 */
async function settleRow(
  row: StagedTrigger,
  data: Prisma.NotificationOutboxUpdateManyMutationInput,
  anchor?: Date,
  split?: Prisma.NotificationOutboxCreateManyInput,
): Promise<boolean> {
  const where = {
    id: row.id,
    status: { in: [...ACTIVE_STATUSES] },
    ...(anchor ? { firstAttemptAt: anchor } : {}),
  };
  try {
    if (!split) {
      const settled = await prisma.notificationOutbox.updateMany({
        where,
        data,
      });
      return settled.count > 0;
    }
    return await prisma.$transaction(async (tx) => {
      const settled = await tx.notificationOutbox.updateMany({ where, data });
      if (settled.count === 0) return false;
      await tx.notificationOutbox.createMany({
        data: [split],
        skipDuplicates: true,
      });
      return true;
    });
  } catch (updateError) {
    console.error(`[Novu] ${row.workflowId} row update failed:`, updateError);
    return false;
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

/** Longest wait a 429 may impose before the normal backoff applies again. */
const MAX_RATE_LIMIT_DELAY_MS = 60 * 60 * 1000;
const delaySecondsSchema = z.coerce.number().finite().nonnegative();

/** The wait Novu asked for on a 429 (`Retry-After`, else `RateLimit-Reset`, in seconds). */
function rateLimitDelayMs(error: unknown): number | undefined {
  if (describeNovuFailure(error).statusCode !== 429) return undefined;
  const headers =
    typeof error === "object" && error !== null && "headers" in error
      ? error.headers
      : undefined;
  if (!(headers instanceof Headers)) return undefined;
  const value = headers.get("retry-after") ?? headers.get("ratelimit-reset");
  if (value === null) return undefined;
  const seconds = delaySecondsSchema.safeParse(value);
  return seconds.success
    ? Math.min(seconds.data * 1000, MAX_RATE_LIMIT_DELAY_MS)
    : undefined;
}

/** Event statuses Novu answers the same way on every retry. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "trigger_not_active",
  "no_workflow_active_steps_defined",
  "no_workflow_steps_defined",
  "no_tenant_found",
  "invalid_recipients",
]);

/** `status` stays a string so a value the SDK's closed enum lacks still parses. */
const eventResultSchema = z.object({
  status: z.string(),
  error: z.array(z.string()).optional(),
  transactionId: z.string().optional(),
});
type EventResult = z.infer<typeof eventResultSchema>;

/** Novu refusing a transactionId it already holds means an earlier attempt delivered it. */
function isDuplicateTransaction(message: string): boolean {
  return (
    /transactionId/i.test(message) && /unique|exist|duplicate/i.test(message)
  );
}

/** What one event's result means for its recipient; an unrecognised status retries. */
function eventOutcome(
  result: EventResult | undefined,
): "accepted" | "retry" | { terminal: string } {
  if (!result) return "retry";
  if (result.status === "processed") return "accepted";
  if (TERMINAL_EVENT_STATUSES.has(result.status)) {
    return { terminal: `novu_${result.status}` };
  }
  if (result.status !== "error") return "retry";
  const message = (result.error ?? []).join("; ");
  if (isDuplicateTransaction(message)) return "accepted";
  if (/workflow_not_found|not found/i.test(message)) {
    return { terminal: "workflow_not_found" };
  }
  return "retry";
}

/**
 * The result body of a 2xx the SDK failed to validate. Any other error is
 * rethrown; an unreadable 2xx becomes a status-less error, so its outcome
 * counts as unknown and is retried, never marked SENT.
 */
function resultOfRejectedResponse<T>(error: unknown, schema: z.ZodType<T>): T {
  const { statusCode } = describeNovuFailure(error);
  if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
    throw error;
  }
  const body =
    typeof error === "object" && error !== null && "body" in error
      ? error.body
      : undefined;
  try {
    return schema.parse(JSON.parse(String(body)));
  } catch {
    throw new Error(`Novu response unreadable (HTTP ${statusCode})`);
  }
}

/**
 * One request's Idempotency-Key. The same anchor, recipients and wire body
 * always give the same key, so a resend after an unknown outcome is deduped
 * by Novu; a new generation or body gives a new key, so Novu never refuses a
 * reused key (422) or replays a refusal it cached (it caches errors for 24 h).
 */
export function triggerIdempotencyKey(
  transactionId: string,
  anchor: Date,
  recipients: string[],
  wire: { workflowId: string; payload: Record<string, unknown> },
): string {
  const digest = sha256Hex(
    `${anchor.toISOString()}|${wire.workflowId}|${recipients.join(",")}|${canonicalJson(wire.payload)}`,
  ).slice(0, 16);
  return recipients.length === 1
    ? `${recipientTransactionId(transactionId, recipients[0])}:${digest}`
    : `${transactionId}:bulk:${digest}`;
}

interface ChunkOutcome {
  accepted: string[];
  retry: string[];
  terminal: Array<{ recipient: string; reason: string }>;
  /** Novu's status for every event that was not accepted. */
  refusedStatuses: string[];
}

interface TriggerEvent {
  workflowId: string;
  to: string;
  payload: Record<string, unknown>;
  transactionId: string;
}

async function triggerOne(
  event: TriggerEvent,
  idempotencyKey: string,
): Promise<EventResult> {
  try {
    return (await getNovuClient().trigger(event, idempotencyKey)).result;
  } catch (error) {
    const { statusCode, novuMessage } = describeNovuFailure(error);
    if (
      statusCode !== undefined &&
      statusCode >= 400 &&
      statusCode < 500 &&
      novuMessage &&
      isDuplicateTransaction(novuMessage)
    ) {
      return { status: "error", error: [novuMessage] };
    }
    return resultOfRejectedResponse(error, eventResultSchema);
  }
}

async function triggerMany(
  events: TriggerEvent[],
  idempotencyKey: string,
): Promise<EventResult[]> {
  try {
    return (await getNovuClient().triggerBulk({ events }, idempotencyKey))
      .result;
  } catch (error) {
    return resultOfRejectedResponse(error, z.array(eventResultSchema));
  }
}

/**
 * One request, an event per recipient under its stable per-recipient
 * transactionId. A single recipient uses the normal trigger: Novu charges a
 * bulk request 100 rate-limit tokens and a trigger one. Throws when the
 * outcome is unknown (no readable response).
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
  const idempotencyKey = triggerIdempotencyKey(
    transactionId,
    anchor,
    chunk,
    wire,
  );
  const events = chunk.map((to) => ({
    workflowId: wire.workflowId,
    to,
    payload: wire.payload,
    transactionId: recipientTransactionId(transactionId, to),
  }));
  const results =
    events.length === 1
      ? [await triggerOne(events[0], idempotencyKey)]
      : await triggerMany(events, idempotencyKey);
  const outcome: ChunkOutcome = {
    accepted: [],
    retry: [],
    terminal: [],
    refusedStatuses: [],
  };
  // Novu echoes each event's transactionId but does not promise result order;
  // only a result without one is matched by position.
  const byTransactionId = new Map<string, EventResult>();
  for (const result of results) {
    if (result.transactionId) byTransactionId.set(result.transactionId, result);
  }
  events.forEach(({ to: recipient, transactionId: eventId }, index) => {
    const positional = results[index];
    const result =
      byTransactionId.get(eventId) ??
      (positional?.transactionId ? undefined : positional);
    const event = eventOutcome(result);
    if (event === "accepted") {
      outcome.accepted.push(recipient);
      return;
    }
    outcome.refusedStatuses.push(result?.status ?? "missing");
    if (event === "retry") outcome.retry.push(recipient);
    else outcome.terminal.push({ recipient, reason: event.terminal });
  });
  return outcome;
}

/**
 * The DEAD_LETTER row that keeps terminally refused recipients visible once
 * they leave a row that still has recipients to send.
 */
function terminalSplitRow(
  row: StagedTrigger,
  terminal: Array<{ recipient: string; reason: string }>,
  attempts: number,
  anchor: Date,
): Prisma.NotificationOutboxCreateManyInput {
  const recipients = terminal.map((t) => t.recipient);
  const digest = sha256Hex(recipients.toSorted(byCodePoint).join(",")).slice(
    0,
    16,
  );
  return {
    workflowId: row.workflowId,
    kind: recipients.length === 1 ? "SINGLE" : "MULTI",
    recipients,
    payload: row.payload as Prisma.InputJsonObject,
    transactionId: `${row.transactionId || row.id}:terminal:${digest}`,
    entityRef: row.entityRef ?? null,
    status: "DEAD_LETTER",
    attempts,
    firstAttemptAt: anchor,
    lastError: `Novu refused ${recipients.length} recipient(s) terminally (${[
      ...new Set(terminal.map((t) => t.reason)),
    ].join(", ")})`,
  };
}

/**
 * Attempts wire delivery for one staged row. A generation's first attempt
 * filters the row by current bell policy and freezes that set together with
 * the `firstAttemptAt` anchor. A retry after an unknown outcome resends
 * exactly that set under the same key, so Novu dedupes it. A definitive
 * response removes the accepted recipients and ends the generation: the rest
 * get a new one, rechecked and re-anchored on the next attempt. Inline
 * attempts leave transient failures PENDING for the drain; relay attempts
 * advance backoff or dead-letter.
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
    settle?: {
      recipients: string[];
      anchor: Date;
      split?: Prisma.NotificationOutboxCreateManyInput;
    },
  ): Promise<TriggerResult> => {
    const applied = await settleRow(
      row,
      {
        status: "DEAD_LETTER",
        attempts,
        lastError,
        ...(settle ? { recipients: settle.recipients } : {}),
      },
      settle?.anchor,
      settle?.split,
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
      ...splitNote(applied, settle?.split),
    };
  };

  const pastReplayWindow = (at: Date | null | undefined) =>
    providerWindowRefusal(at ? new Date(at) : null, now) !== null;
  if (pastReplayWindow(row.firstAttemptAt)) {
    return deadLetter(PROVIDER_WINDOW_EXPIRED, row.attempts);
  }

  let recipients = row.recipients;
  let anchor = row.firstAttemptAt ? new Date(row.firstAttemptAt) : null;
  if (anchor) {
    // A retry keeps its body across soft opt-outs, but an erased or deleted
    // user is always dropped: privacy outranks the duplicate risk.
    try {
      recipients = await unerasedRecipients(row.recipients);
    } catch (error) {
      return { success: false, error: asError(error), outcome: "PENDING" };
    }
    if (recipients.length === 0) {
      return deadLetter("policy:audience_revoked", row.attempts);
    }
  } else {
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
  // Nobody accepted these under the sent key, so the next attempt starts a
  // new generation: policy recheck, new anchor, new key.
  const freshGeneration = (remaining: string[]) => ({
    recipients: remaining,
    firstAttemptAt: null,
    lastError: null,
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
    settle: {
      reason: string | null;
      /** The recipients the row keeps after a definitive response. */
      keep?: string[];
      terminal?: Array<{ recipient: string; reason: string }>;
      retryAfterMs?: number;
    },
  ): Promise<TriggerResult> => {
    const lastError = errorText(failure);
    const split =
      settle.terminal && settle.terminal.length > 0
        ? terminalSplitRow(row, settle.terminal, attempts, sentAnchor)
        : undefined;
    if (settle.reason || exhaustedRetries) {
      const dead = await deadLetter(
        lastError,
        attempts,
        settle.keep && {
          recipients: settle.keep,
          anchor: sentAnchor,
          split,
        },
      );
      return { ...dead, success: false, error: failure };
    }
    const guard = settle.keep ? sentAnchor : undefined;
    const progress = settle.keep ? freshGeneration(settle.keep) : { lastError };
    if (opts.relay) {
      const backoff = nextRetryAt(attempts + 1, now);
      const retryAt =
        settle.retryAfterMs === undefined
          ? backoff
          : new Date(
              Math.max(backoff.getTime(), now.getTime() + settle.retryAfterMs),
            );
      const applied = await settleRow(
        row,
        { status: "RETRY", attempts, nextRetryAt: retryAt, ...progress },
        guard,
        split,
      );
      Sentry.metrics?.count?.("notifications.outbox.transition", 1, {
        attributes: { status: "RETRY", workflowId: row.workflowId },
      });
      return {
        success: false,
        error: failure,
        outcome: "RETRY",
        ...splitNote(applied, split),
        ...(settle.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: settle.retryAfterMs }),
      };
    }
    const applied = await settleRow(row, progress, guard, split);
    return {
      success: false,
      error: failure,
      outcome: "PENDING",
      ...splitNote(applied, split),
    };
  };

  // One request per attempt keeps an attempt inside the drain's wave budget;
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
    return settleFailure(asError(error), {
      reason: reported.reason,
      retryAfterMs: rateLimitDelayMs(error),
    });
  }

  const refused = sent.retry.length + sent.terminal.length;
  if (refused === 0) {
    console.log(
      `[Novu] Triggered ${row.workflowId} for ${chunk.length} subscribers`,
    );
    if (unsent.length === 0) return markSent();
    // Progress, not a failure: no attempt is spent and the rest is due now.
    await settleRow(
      row,
      { ...freshGeneration(unsent), nextRetryAt: now },
      sentAnchor,
    );
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
  if (remaining.length === 0) {
    // Only terminal refusals are left: the row itself dead-letters with them.
    const terminalReason = dropped[0] ?? null;
    reportTriggerFailure(failure, row.workflowId, chunk.length, {
      ...reportOpts,
      terminalReason,
    });
    return settleFailure(failure, {
      reason: terminalReason,
      keep: sent.terminal.map((t) => t.recipient),
    });
  }
  reportTriggerFailure(failure, row.workflowId, chunk.length, reportOpts);
  return settleFailure(failure, {
    reason: null,
    keep: remaining,
    terminal: sent.terminal,
  });
}

function splitNote(
  applied: boolean,
  split: Prisma.NotificationOutboxCreateManyInput | undefined,
): Pick<TriggerResult, "terminalSplit"> {
  return applied && split?.lastError ? { terminalSplit: split.lastError } : {};
}

export { MAX_ATTEMPTS as OUTBOX_MAX_ATTEMPTS };
