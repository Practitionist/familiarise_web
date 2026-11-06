import type { Prisma } from "@prisma/client";
import type { RunContext } from "@/lib/cron/run-context";
import { runTelemetryResult, settleTelemetry } from "@/lib/cron/run-telemetry";
import {
  jobEnvironment,
  runItems,
  statusOfOutcome,
  type RunItemCounts,
  type RunOutcome,
} from "@/lib/cron/run-outcome";

/** A summary above this is stored as a size marker; raw detail belongs in the logs. */
const SUMMARY_MAX_CHARS = 8_000;

const STAND_DOWN_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
  "held",
  "skipped",
  "refused",
  "paused",
]);

export interface RouteRunRecord {
  /** The route's job name, used when a stand-down opened no row. */
  jobName: string;
  outcome: RunOutcome;
  reason?: string;
  httpStatus: number;
  summary?: unknown;
  /** The job's own counts; they win over the generic summary-key extractor. */
  items?: RunItemCounts;
  holderRunId?: string | null;
}

async function summaryJson(
  summary: unknown,
): Promise<Prisma.InputJsonValue | undefined> {
  if (summary === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(summary, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return { unserializable: true };
  }
  if (text === undefined) return undefined;
  if (text.length > SUMMARY_MAX_CHARS) {
    return { truncated: true, chars: text.length };
  }
  const { toInputJson } = await import("@/lib/webhooks/event-log");
  return toInputJson(JSON.parse(text));
}

function itemColumns(record: RouteRunRecord): {
  itemsProcessed: number | null;
  errorCount: number | null;
} {
  const generic = runItems(record.summary);
  if (!record.items) return generic;
  return {
    itemsProcessed: record.items.processed,
    errorCount: record.items.errors ?? generic.errorCount,
  };
}

/**
 * The route's verdict on the rows its run opened: one CAS update per row whose
 * own finish write landed, or one zero-duration CANCELLED row for a stand-down
 * that opened none. Best effort; a failed write never changes the response.
 */
export async function recordRouteRun(
  run: RunContext,
  record: RouteRunRecord,
): Promise<void> {
  try {
    const status = statusOfOutcome(record.outcome);
    const summary = await summaryJson(record.summary);
    await settleTelemetry(run.telemetry);
    const base = {
      outcome: record.outcome,
      reason: record.reason,
      environment: jobEnvironment(),
      httpStatus: record.httpStatus,
      counters: run.counters,
      tickId: run.tickId,
      opsActionLogId: run.opsActionLogId,
      holderRunId: record.holderRunId ?? undefined,
      summary,
      ...runTelemetryResult(run.telemetry),
    };
    const { default: prisma } = await import("@/lib/prisma");
    if (run.finished.size > 0) {
      const items = itemColumns(record);
      for (const [id, checkpoint] of run.finished) {
        await prisma.systemJobExecution.updateMany({
          where: { id, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
          data: {
            status,
            result: { ...base, ...checkpoint },
            itemsProcessed: items.itemsProcessed,
            errorCount: items.errorCount,
          },
        });
      }
      return;
    }
    if (run.runIds.length > 0 || !STAND_DOWN_OUTCOMES.has(record.outcome)) {
      return;
    }
    const now = new Date();
    await prisma.systemJobExecution.create({
      data: {
        jobId: record.jobName,
        jobName: record.jobName,
        status,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        triggeredBy: run.triggeredBy,
        result: base,
      },
      select: { id: true },
    });
  } catch (err) {
    console.warn(`[${record.jobName}] run record write failed:`, err);
  }
}
