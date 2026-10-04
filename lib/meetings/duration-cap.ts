/**
 * Pure server-side call duration cap policy.
 * Computes `max_duration_seconds` from booked slot bounds plus early-join and overrun buffers.
 */
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";

/** Overrun and rejoin buffer added to the booked slot duration. */
export const CALL_DURATION_GRACE_MS = 30 * 60 * 1000;

/** Minimum cap for valid positive slots (45m) and ceiling for any call (12h). */
export const MIN_CALL_DURATION_MS = 45 * 60 * 1000;
export const MAX_CALL_DURATION_MS = 12 * 60 * 60 * 1000;
const CORRUPT_SLOT_FALLBACK_MS = 2 * 60 * 60 * 1000;

/**
 * Computes `limits.max_duration_seconds` (counted from first join) as
 * `bookedMs + CONSULTANT_JOIN_WINDOW_MS + CALL_DURATION_GRACE_MS`, or `null` when
 * the call profile could not be resolved.
 */
export function resolveMaxCallDurationSeconds(
  callProfile: { endsAt: Date } | null,
  startsAt: Date,
): number | null {
  if (!callProfile) return null;

  const rawBookedMs = callProfile.endsAt.getTime() - startsAt.getTime();
  if (rawBookedMs <= 0) {
    return Math.ceil(CORRUPT_SLOT_FALLBACK_MS / 1000);
  }

  const budgetMs =
    rawBookedMs + CONSULTANT_JOIN_WINDOW_MS + CALL_DURATION_GRACE_MS;

  const clamped = Math.min(
    Math.max(budgetMs, MIN_CALL_DURATION_MS),
    MAX_CALL_DURATION_MS,
  );
  return Math.ceil(clamped / 1000);
}
