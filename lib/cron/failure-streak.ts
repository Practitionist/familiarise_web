import { z } from "zod";

/** A target is a repeat failure when it has no COMPLETED run for three of its own cadences. */
export const STREAK_CADENCES = 3;

export const streakReportSchema = z.record(
  z.string(),
  z.object({
    lastCompletedAt: z.string().nullable(),
    lastFailedAt: z.string().nullable().optional(),
    seenRecently: z.boolean(),
  }),
);
export type StreakReport = z.infer<typeof streakReportSchema>;

/** The target's newest finished run failed; for a background target this stands in for its outcome. */
export function lastRunFailed(
  entry: StreakReport[string] | undefined,
): boolean {
  if (!entry?.lastFailedAt) return false;
  return (
    entry.lastCompletedAt === null ||
    Date.parse(entry.lastFailedAt) > Date.parse(entry.lastCompletedAt)
  );
}

/**
 * Unknown history (no rows at all, or no report) is never a repeat, so a job
 * whose execution rows use another name cannot escalate by accident.
 */
export function isRepeatedFailure(
  everyMinutes: number,
  entry: StreakReport[string] | undefined,
  now: Date,
): boolean {
  if (!entry?.seenRecently) return false;
  if (entry.lastCompletedAt === null) return true;
  const last = Date.parse(entry.lastCompletedAt);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last > STREAK_CADENCES * everyMinutes * 60_000;
}

/** Netlify's own error page, returned when the function never ran. */
export function isPlatformErrorBody(errorBody: string | undefined): boolean {
  return (errorBody ?? "").startsWith("Internal Server Error - Request ID");
}
