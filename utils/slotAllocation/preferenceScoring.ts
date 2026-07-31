/**
 * Allocation preferences — scoring, never filtering (#1065).
 *
 * A consultee who releases a session without naming a time may still say how
 * they would like the replacement placed. The rule that makes that safe is the
 * whole point of this module:
 *
 *   **A preference orders candidates. It never removes one.**
 *
 * The dead client-side allocator this replaces got it backwards. It filtered:
 * `if (preferences.preferMorning && (hour < 9 || hour >= 12)) return false`.
 * Prefer-mornings against a consultant who only works afternoons therefore
 * answered "no slots available" with the whole afternoon free — the same shape
 * as the A1 defect where the search tested one candidate start per availability
 * row. The worst outcome of an unsatisfiable preference has to be a less-liked
 * time, never a failed allocation, so nothing here returns a boolean the caller
 * could use to drop a candidate.
 *
 * Bands are read in the event's scheduling timezone (ADR B9), not server-local
 * and not raw UTC: "morning" means the customer's morning.
 */

import type {
  ReschedulePreferredDays,
  ReschedulePreferredTimeOfDay,
} from "@prisma/client";

import { SlotCalculationService } from "./SlotCalculationService";

/**
 * What the initiator asked for. Both halves are independent and optional, so
 * "weekday mornings", "mornings", "weekends" and "no preference at all" are all
 * expressible without a combinatorial enum.
 */
export interface AllocationPreference {
  preferredTimeOfDay?: ReschedulePreferredTimeOfDay | null;
  preferredDays?: ReschedulePreferredDays | null;
}

/**
 * Half-open hour bands, contiguous and covering the clock, so every candidate
 * falls in exactly one and no time is left unscoreable. EVENING deliberately
 * wraps midnight and takes everything the other two do not.
 */
const TIME_OF_DAY_BANDS: Record<
  ReschedulePreferredTimeOfDay,
  (hour: number) => boolean
> = {
  MORNING: (hour) => hour >= 5 && hour < 12,
  AFTERNOON: (hour) => hour >= 12 && hour < 17,
  EVENING: (hour) => hour >= 17 || hour < 5,
};

const WEEKEND_DAYS = new Set([0, 6]);

/**
 * Both halves weigh the same, so the score is simply how many of the stated
 * preferences a candidate satisfies. Ranking one above the other would decide
 * on the customer's behalf whether "Saturday morning" beats "Tuesday morning"
 * for someone who asked for weekday mornings; an equal weight leaves that tie
 * to the existing chronological order, which prefers the sooner session.
 */
const PREFERENCE_WEIGHT = 1;

/** True when the preference expresses nothing — absent or all-null. */
export function isEmptyPreference(
  preference?: AllocationPreference | null,
): boolean {
  return !preference?.preferredTimeOfDay && !preference?.preferredDays;
}

/**
 * The score a candidate satisfying every stated preference would earn.
 *
 * Zero when nothing was asked for, which is what lets the callers keep their
 * original first-fit behaviour verbatim: every candidate already scores the
 * maximum, so the first placeable one wins and the search returns exactly where
 * it did before this existed.
 */
export function maxPreferenceScore(
  preference?: AllocationPreference | null,
): number {
  let max = 0;
  if (preference?.preferredTimeOfDay) max += PREFERENCE_WEIGHT;
  if (preference?.preferredDays) max += PREFERENCE_WEIGHT;
  return max;
}

/** Whether an instant falls in the preferred part of the week. */
export function matchesPreferredDays(
  start: Date,
  preference: AllocationPreference | null | undefined,
  timeZone?: string,
): boolean {
  if (!preference?.preferredDays) return true;
  const isWeekend = WEEKEND_DAYS.has(
    SlotCalculationService.weekdayInTz(start, timeZone),
  );
  return preference.preferredDays === "WEEKENDS" ? isWeekend : !isWeekend;
}

/**
 * How well a candidate start matches, from 0 to `maxPreferenceScore`.
 *
 * Higher is better and nothing is ever disqualified — a zero-scoring candidate
 * is still a perfectly allocatable one, just not the one anybody asked for.
 */
export function scoreCandidateStart(
  start: Date,
  preference: AllocationPreference | null | undefined,
  timeZone?: string,
): number {
  if (isEmptyPreference(preference)) return 0;

  let score = 0;

  const band = preference?.preferredTimeOfDay;
  if (band) {
    const hour = SlotCalculationService.hourInTz(start, timeZone);
    if (TIME_OF_DAY_BANDS[band](hour)) score += PREFERENCE_WEIGHT;
  }

  if (preference?.preferredDays && matchesPreferredDays(start, preference, timeZone)) {
    score += PREFERENCE_WEIGHT;
  }

  return score;
}
