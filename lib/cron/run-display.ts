import { runOutcomeSchema, type RunOutcome } from "@/lib/cron/run-outcome";

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  completed: "Completed",
  attention: "Needs attention",
  partial: "Partial",
  failed: "Failed",
  held: "Held",
  skipped: "Skipped",
  refused: "Refused",
  paused: "Paused",
};

/** Bookkeeping the run row stores beside the summary; never shown as a count. */
const META_KEYS: ReadonlySet<string> = new Set([
  "outcome",
  "reason",
  "environment",
  "httpStatus",
  "counters",
  "tickId",
  "opsActionLogId",
  "holderRunId",
  "summary",
  "checkpoint",
  "success",
]);
const MAX_TEXT_CHARS = 40;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

const STAND_DOWNS: ReadonlySet<RunOutcome> = new Set([
  "held",
  "skipped",
  "refused",
  "paused",
]);

/** A run that stood down (held, skipped, refused, paused): reported to the operator, never as an error. */
export function isStandDownOutcome(outcome: unknown): boolean {
  const parsed = runOutcomeSchema.safeParse(outcome);
  return parsed.success && STAND_DOWNS.has(parsed.data);
}

/** The label of a recorded outcome, or null when the value is not one. */
export function outcomeLabel(outcome: unknown): string | null {
  const parsed = runOutcomeSchema.safeParse(outcome);
  return parsed.success ? OUTCOME_LABELS[parsed.data] : null;
}

/** The first `max` scalar fields as `key: value`; objects and arrays are skipped, never stringified. */
export function scalarFields(source: unknown, max: number): string[] {
  const record = asRecord(source);
  if (!record) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (lines.length >= max) break;
    if (META_KEYS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else if (typeof value === "string" && value.length <= MAX_TEXT_CHARS) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines;
}

/** The stored summary of a new-format run row, else the flat result of an older one. */
export function summaryFields(result: unknown, max: number): string[] {
  const summary = asRecord(asRecord(result)?.summary);
  return scalarFields(summary ?? result, max);
}

export function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}
