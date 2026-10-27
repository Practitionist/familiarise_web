import { z } from "zod";
import type { ConfigSkip } from "@/lib/cron/config-skip";
import { jobOutcome, type JobOutcome } from "@/lib/cron/job-outcome";

/**
 * `SystemJobExecution.result.outcome`. `paused` is reserved for the job pause
 * control and has no writer yet.
 */
export const runOutcomeSchema = z.enum([
  "completed",
  "partial",
  "failed",
  "held",
  "skipped",
  "refused",
  "paused",
]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export type FinishedStatus = "COMPLETED" | "FAILED" | "CANCELLED";

/** A partial run is FAILED so streaks escalate it; SLO freshness still counts it as having run to the end. */
export function statusOfOutcome(outcome: RunOutcome): FinishedStatus {
  if (outcome === "completed") return "COMPLETED";
  if (outcome === "partial" || outcome === "failed") return "FAILED";
  return "CANCELLED";
}

/** The lock's own verdict for callers outside a cleanup route (CLI entrypoints, background functions). */
export function runOutcomeOfJob(outcome: JobOutcome): RunOutcome {
  if (outcome === "success") return "completed";
  if (outcome === "partial_failure") return "partial";
  if (outcome === "held") return "skipped";
  return "failed";
}

export function jobEnvironment(): string {
  return (
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.SENTRY_ENVIRONMENT ??
    "unknown"
  );
}

const checkpointSchema = z.object({ checkpoint: z.string().nullable() });

/** A job that pages across runs returns `checkpoint`; the trail keeps it for the next run. */
export function checkpointOf(
  result: unknown,
): { checkpoint: string | null } | null {
  const parsed = checkpointSchema.safeParse(result);
  return parsed.success ? { checkpoint: parsed.data.checkpoint } : null;
}

const skippedSchema = z.object({ skipped: z.string() });

function isConfigSkip(value: string): value is ConfigSkip {
  return value.endsWith(" not configured");
}

/** The reason a run did nothing because a required setting is absent, else null. */
export function configSkipReason(result: unknown): ConfigSkip | null {
  const parsed = skippedSchema.safeParse(result);
  return parsed.success && isConfigSkip(parsed.data.skipped)
    ? parsed.data.skipped
    : null;
}

/**
 * The outcome of a run that returned, judged by the HTTP status the route
 * answered so the row and the response always agree.
 */
export function routeOutcome(
  result: unknown,
  httpStatus: number,
): { outcome: RunOutcome; reason?: string } {
  const skip = configSkipReason(result);
  if (skip) return { outcome: "skipped", reason: skip };
  if (httpStatus === 503 && jobOutcome(result) === "held") {
    return { outcome: "skipped", reason: "job-declined" };
  }
  if (httpStatus >= 400) return { outcome: "failed" };
  if (httpStatus === 207) return { outcome: "partial" };
  return { outcome: "completed" };
}

const ITEM_KEYS = [
  "itemsProcessed",
  "totalProcessed",
  "processed",
  "scanned",
  "examined",
  "totalCleaned",
  "totalDeleted",
] as const;
const ERROR_KEYS = [
  "errorCount",
  "failedCount",
  "failed",
  "errors",
  "stillFailing",
] as const;

function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function firstCount(
  summary: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const count = countOf(summary[key]);
    if (count !== null) return count;
  }
  return null;
}

/** The first known item and error counters a summary carries; null when it carries none. */
export function runItems(summary: unknown): {
  itemsProcessed: number | null;
  errorCount: number | null;
} {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return { itemsProcessed: null, errorCount: null };
  }
  const record = Object.fromEntries(Object.entries(summary));
  return {
    itemsProcessed: firstCount(record, ITEM_KEYS),
    errorCount: firstCount(record, ERROR_KEYS),
  };
}
