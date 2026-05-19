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

import prisma from "@/lib/prisma";
import type { Prisma, SystemEventSeverity } from "@prisma/client";

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
}

/**
 * Record one operational event. Best-effort: if the insert fails we
 * log to console and return without throwing so the caller's main
 * code path is unaffected.
 */
export async function recordSystemEvent(
  params: RecordSystemEventParams,
): Promise<void> {
  try {
    await prisma.systemEvent.create({
      data: {
        organizationId: params.organizationId ?? null,
        category: params.category,
        severity: params.severity ?? "INFO",
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
  }
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
  });
}
