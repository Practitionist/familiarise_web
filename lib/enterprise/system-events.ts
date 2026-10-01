/**
 * Recorder for platform-side operational events. Distinct from
 * `OrgAuditLog` — see SystemEvent docstring in prisma/schema.prisma.
 *
 * Use this helper from any code path that needs to capture engineering-
 * facing context (Prisma stack traces, raw HTTP responses, internal IDs)
 * without leaking that information into the org-visible audit log. The
 * org gets a clean, human-readable audit row alongside; engineering
 * queries this table.
 *
 * The helper is best-effort: a failure here must not block the calling
 * code path. We swallow + log to console so a failing system_events
 * insert doesn't take down the worker.
 */

import * as Sentry from "@sentry/nextjs";
import prisma, { type Tx } from "@/lib/prisma";
import type { Prisma, SystemEventSeverity } from "@prisma/client";
import { emitTelemetryLog } from "@/lib/observability/betterstack-telemetry";
import {
  reportSentryError,
  SYSTEM_EVENT_WRITE_FAILURE_MARKER,
} from "@/lib/observability/report";

// Map the DB severity enum onto the telemetry sink's level.
function severityToTelemetryLevel(
  severity: SystemEventSeverity,
): "info" | "warn" | "error" {
  if (severity === "ERROR") return "error";
  if (severity === "WARN") return "warn";
  return "info";
}

export interface RecordSystemEventParams {
  /** Optional org scope. Platform-wide events leave this null. */
  organizationId?: string | null;
  /** Functional bucket (DATA_EXPORT / HRIS_SYNC / WEBHOOK / PAYOUT / CRON / ...). */
  category: string;
  severity?: SystemEventSeverity;
  /**
   * Engineering-grade message. Safe to include Prisma error text,
   * HTTP status codes, internal IDs. Never rendered to org users.
   */
  message: string;
  /**
   * Free-form payload — stack trace, request ID, related row IDs.
   * Stringified at write time if the caller hands a non-plain object.
   */
  context?: Record<string, unknown> | null;
  /**
   * Optional correlation ID — typically the parent job ID (e.g. the
   * `OrgDataExportJob.id` that failed). Lets engineering pull all
   * events for one invocation in a single query.
   */
  correlationId?: string | null;
  /**
   * Rethrow when the insert fails instead of swallowing it. For callers whose
   * row is the only audit trail; see the note on the function below.
   */
  strict?: boolean;
  /**
   * #1582 B-P1-02 — the client to write through. Inside a transaction pass
   * `tx`: with PG_POOL_MAX=1 a global-client insert queues behind the open
   * transaction and dies at the 3 s connect timeout if Phase 1 outlives it.
   * Same convention as `recordTDSDeduction`. Defaults to the global client.
   */
  db?: Tx | typeof prisma;
}

/**
 * Record one operational event. Best-effort by default: if the insert fails we
 * log to console and return without throwing so the caller's main
 * code path is unaffected.
 *
 * #1270 — pass `strict` when the row is an AUTHORIZATION RECORD rather than
 * telemetry. Operator access to a B2C recording has no `OrgAuditLog` to fall
 * back on, so a swallowed insert there means the read is served with no
 * persisted trail at all. Those callers need the failure, not the console line.
 */
export async function recordSystemEvent(
  params: RecordSystemEventParams & {
    /**
     * Internal. Set by the `*Safe` wrappers so a swallowed insert failure is
     * re-thrown to *them* — and to nobody else, which is what keeps every
     * existing caller's never-reject contract intact.
     */
    __reportInsertFailureToCaller?: boolean;
  },
): Promise<void> {
  const severity = params.severity ?? "INFO";
  const db = params.db ?? prisma;
  try {
    await db.systemEvent.create({
      data: {
        organizationId: params.organizationId ?? null,
        category: params.category,
        severity,
        message: params.message,
        // `Record<string, unknown>` widens to Prisma's
        // `InputJsonValue` at the storage boundary. Cast is local
        // and intentional — the JSON shape is operator-defined.
        context: (params.context ?? undefined) as Prisma.InputJsonValue,
        correlationId: params.correlationId ?? null,
      },
    });
  } catch (err) {
    // The system_events insert itself failed — log and move on. An
    // outage of this table must not cascade into the calling worker.
    console.error("[recordSystemEvent] insert failed:", err);
    if (params.strict || params.__reportInsertFailureToCaller) throw err;
  }

  // Fire-and-forget telemetry sink (#776 §K). The DB row above is the source
  // of truth; this just gets the event somewhere an on-call human sees it.
  // NOT awaited — `recordSystemEvent` runs on the webhook critical path (HMAC
  // failure), so awaiting an external HTTP POST would let a stalled Better
  // Stack block/DoS the handler. No-op unless ENABLE_BETTERSTACK_TELEMETRY is
  // on; the call is internally best-effort, the `.catch` is belt-and-suspenders.
  void emitTelemetryLog({
    level: severityToTelemetryLevel(severity),
    message: params.message,
    category: params.category,
    organizationId: params.organizationId,
    correlationId: params.correlationId,
    context: params.context,
  }).catch((err) => {
    console.error("[recordSystemEvent] telemetry sink failed:", err);
  });
}

/**
 * Convenience wrapper for the common "an exception was caught"
 * pattern. Extracts the message + stack into the context payload
 * automatically.
 */
export async function recordSystemError(params: {
  organizationId?: string | null;
  category: string;
  /** Human prose summary — e.g. "Data export bundle failed". */
  summary: string;
  err: unknown;
  context?: Record<string, unknown>;
  correlationId?: string | null;
  /** #1582 B-P1-02 — see RecordSystemEventParams.db. */
  db?: Tx | typeof prisma;
  /** Internal — see RecordSystemEvent's flag of the same name. */
  __reportInsertFailureToCaller?: boolean;
}): Promise<void> {
  const errorMessage =
    params.err instanceof Error ? params.err.message : String(params.err);
  const stack = params.err instanceof Error ? params.err.stack : undefined;

  await recordSystemEvent({
    organizationId: params.organizationId,
    category: params.category,
    severity: "ERROR",
    message: `${params.summary}: ${errorMessage}`,
    context: {
      ...(params.context ?? {}),
      errorMessage,
      ...(stack ? { stack } : {}),
    },
    correlationId: params.correlationId,
    db: params.db,
    __reportInsertFailureToCaller: params.__reportInsertFailureToCaller,
  });

  // Escalate to Sentry so engineers see it without querying the DB.
  // Best-effort: never throw. Callers of recordSystemError already swallow
  // exceptions, so a failing captureException must not change that contract.
  const errorObj =
    params.err instanceof Error ? params.err : new Error(errorMessage);
  Sentry.captureException(errorObj, {
    tags: { subsystem: "system-events", category: params.category },
    contexts: {
      systemEvent: {
        organizationId: params.organizationId ?? null,
        category: params.category,
        summary: params.summary,
        correlationId: params.correlationId ?? null,
      },
    },
  });
}

// Wave-3 hardening (#1230): ~15 call sites invoke this as
// `void recordSystemError(...)` relying on an informal never-throw contract —
// an unexpected throw (e.g. a getter blowing up inside a params spread) would
// surface as an unhandled rejection and crash the host on Node ≥15. The
// returned promise is wrapped post-hoc here so EVERY void-site is covered
// without touching each call site; awaited callers still get settled void.
export function recordSystemErrorSafe(
  params: Parameters<typeof recordSystemError>[0],
): Promise<void> {
  return recordSystemError({
    ...params,
    __reportInsertFailureToCaller: true,
  }).catch((err) => {
    console.error("[system-events] recordSystemError threw:", err);
    reportSystemEventWriteFailure("recordSystemError", err);
  });
}

/**
 * Report that recording a `SystemEvent` itself failed.
 *
 * This is the blind spot the two `*Safe` wrappers were hiding: a failed audit
 * write used to be visible only in Netlify logs, and the sites that matter
 * most — the CRITICAL_DISPUTE_UNLINKED page, the consultant clawback, the
 * missing-ledger-transaction page, the overage-base restore — are exactly the
 * ones nobody reads logs for.
 *
 * `expected: true` because the *report* is the failure, not a new fault: the
 * thing that actually broke is whatever made the write fail, and that is
 * reported by its own path. It becomes a Sentry **info**-level event with
 * `expected:true`, so it is findable without paging anyone for a database
 * blip.
 *
 * The quota argument is NOT made here, because it does not hold: Sentry counts
 * every event against the error allowance regardless of level, so `expected`
 * buys severity, not budget. What bounds the budget is the throttle — this
 * marker is matched by `INFRA_TRANSIENT_PATTERNS`, so repeats inside a
 * 10-minute window are dropped before transport and cost nothing. During a
 * systemic database outage every call site fails at once, which is precisely
 * the flood shape that spent the 2026-09-21 allowance.
 *
 * Must never throw. It runs inside the `.catch()` of a never-throw contract,
 * and an observability helper that raised there would convert a handled
 * failure into an unhandled rejection — the exact crash the wrappers exist to
 * prevent.
 */
function reportSystemEventWriteFailure(
  operation: "recordSystemEvent" | "recordSystemError",
  err: unknown,
): void {
  try {
    // The thrown value may be a Prisma error whose `message` and `meta` carry
    // constraint text, column values, or a connection string. Report the
    // operation and a coarse class only; the original object is deliberately
    // NOT forwarded as `cause` or `extra`, because anything handed to
    // captureException is subject to transport and retention, and we have not
    // audited which fields in it are safe. The message stays in the local log
    // above, which is not shipped anywhere.
    const errorClass =
      err instanceof Error
        ? err.name || "Error"
        : typeof err === "object" && err !== null
          ? ((err as { constructor?: { name?: string } }).constructor?.name ??
            "object")
          : typeof err;
    reportSentryError(
      new Error(
        `${SYSTEM_EVENT_WRITE_FAILURE_MARKER}: ${operation} failed (${errorClass})`,
      ),
      {
        subsystem: "observability",
        op: "system-event-write-failed",
        expected: true,
        extra: { operation, errorClass },
      },
    );
  } catch {
    // Nothing left to report to. Losing the report is strictly better than
    // letting the reporting itself become the unhandled rejection.
  }
}

/**
 * The `recordSystemEvent` counterpart of {@link recordSystemErrorSafe}, added
 * for the same reason.
 *
 * `recordSystemErrorSafe` only covers error records, so every void call site
 * that recorded a plain event had to hand-roll its own guard. Almost all of
 * them wrote `void recordSystemEvent({...}).catch(() => {})` — which throws
 * the diagnostic away entirely, and does so at exactly the sites that matter
 * most: the CRITICAL_DISPUTE_UNLINKED page, the consultant-paid-earnings
 * clawback, the missing-booking-ledger-transaction page, and the
 * overage-base restore. The mechanism that exists to record a money-path fault
 * was itself the thing quietly failing. `console.error` in the replacement
 * handler is intentional and non-silent.
 */
export function recordSystemEventSafe(
  params: Parameters<typeof recordSystemEvent>[0],
): Promise<void> {
  return recordSystemEvent({
    ...params,
    __reportInsertFailureToCaller: true,
  }).catch((err) => {
    console.error("[system-events] recordSystemEvent threw:", err);
    reportSystemEventWriteFailure("recordSystemEvent", err);
  });
}

export { SYSTEM_EVENT_WRITE_FAILURE_MARKER };
