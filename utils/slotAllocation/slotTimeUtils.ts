/**
 * Utility functions for converting between Int (minutes since midnight UTC)
 * and human-readable time representations.
 *
 * Used by SlotOfAvailabilityWeekly which stores availability times as
 * Int (0-1439) instead of DateTime, eliminating timezone confusion.
 *
 * FIX Issue #6 from Architecture Review (#446):
 * The old DateTime @db.Timestamptz() fields were anchored to 1970-01-05
 * with only the time portion being meaningful. These utilities support
 * the new Int-based representation.
 */

import { DayOfWeek, Prisma } from "@prisma/client";

/**
 * Convert minutes-since-midnight-UTC to "HH:MM" string
 * @param minutes - Minutes since midnight (0-1439)
 * @returns Formatted time string e.g. "09:30"
 */
export function minutesToTimeString(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Convert "HH:MM" string to minutes-since-midnight
 * @param timeStr - Time string in "HH:MM" format
 * @returns Minutes since midnight (0-1439)
 */
export function timeStringToMinutes(timeStr: string): number {
  const [hours, mins] = timeStr.split(":").map(Number);
  return hours * 60 + mins;
}

/**
 * Convert minute-of-day UTC to a concrete Date on a given reference date.
 * Used when the calendar needs to plot weekly availability slots on specific dates.
 *
 * @param minuteUtc - Minutes since midnight UTC (0-1439)
 * @param referenceDate - The date to use as the base (time portion is overwritten)
 * @returns Date object with UTC time set to the specified minutes
 */
export function minuteUtcToDate(minuteUtc: number, referenceDate: Date): Date {
  const result = new Date(referenceDate);
  result.setUTCHours(Math.floor(minuteUtc / 60), minuteUtc % 60, 0, 0);
  return result;
}

/**
 * Map DayOfWeek enum string to JS getUTCDay() index (Sunday=0 ... Saturday=6)
 *
 * Shared constant used by SlotAllocationService and SlotValidationService
 * to convert Prisma DayOfWeek enum values to numeric day indices.
 */
export const DAY_OF_WEEK_TO_INDEX: Record<string, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

/**
 * Extract minutes-since-midnight from a Date object (UTC)
 * Useful when converting from Date-based slot representations.
 *
 * @param date - Date to extract time from
 * @returns Minutes since midnight UTC (0-1439)
 */
export function dateToMinuteUtc(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/**
 * Ordered array of DayOfWeek enum values matching JS getUTCDay() indices (Sunday=0).
 */
const DAY_ORDER: DayOfWeek[] = [
  DayOfWeek.SUNDAY,
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
  DayOfWeek.SATURDAY,
];

/**
 * Check if endDay is the next day of the week after startDay.
 */
export function isNextDayOfWeek(startDay: DayOfWeek, endDay: DayOfWeek): boolean {
  const startIdx = DAY_ORDER.indexOf(startDay);
  const endIdx = DAY_ORDER.indexOf(endDay);
  if (startIdx === -1 || endIdx === -1) return false;
  return (startIdx + 1) % 7 === endIdx;
}

/**
 * Validate time ordering for weekly slots, accounting for overnight (cross-midnight) slots.
 * Same-day: startTimeUtc must be < endTimeUtc.
 * Overnight (startDay !== endDay): endDay must be exactly the next day; startTimeUtc CAN be > endTimeUtc.
 *
 * @returns null if valid, or an error message string if invalid
 */
export function validateWeeklySlotTimeOrder(
  startDay: DayOfWeek,
  endDay: DayOfWeek,
  startTimeUtc: number,
  endTimeUtc: number,
): string | null {
  if (startDay === endDay) {
    if (startTimeUtc >= endTimeUtc) {
      return "Start time must be before end time for same-day slots";
    }
  } else {
    if (!isNextDayOfWeek(startDay, endDay)) {
      return "For overnight slots, endDay must be the day after startDay";
    }
    // Overnight slots must actually cross midnight: startTimeUtc > endTimeUtc
    // e.g., Mon 22:00 (1320) → Tue 02:00 (120): 1320 > 120 ✓
    // Reject: Mon 02:00 (120) → Tue 22:00 (1320): would be >24h, not a real overnight slot
    if (startTimeUtc <= endTimeUtc) {
      return "Overnight slots must cross midnight (start time must be later in the day than end time)";
    }
  }
  return null;
}

/**
 * Build a Prisma WHERE clause to detect overlapping weekly availability slots.
 * Handles both same-day and overnight (cross-midnight) slots.
 *
 * @param consultantProfileId - Consultant to scope to
 * @param startDay - DayOfWeek for slot start
 * @param endDay - DayOfWeek for slot end
 * @param startTimeUtc - Minutes since midnight UTC for start
 * @param endTimeUtc - Minutes since midnight UTC for end
 * @param excludeId - Optional slot ID to exclude (for updates)
 */
export function buildWeeklyOverlapWhere(
  consultantProfileId: string,
  startDay: DayOfWeek,
  endDay: DayOfWeek,
  startTimeUtc: number,
  endTimeUtc: number,
  excludeId?: string,
): Prisma.SlotOfAvailabilityWeeklyWhereInput {
  const baseWhere: Prisma.SlotOfAvailabilityWeeklyWhereInput = {
    consultantProfileId,
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };

  const isSameDay = startDay === endDay;

  if (isSameDay) {
    // Same-day slot: check against
    // 1. Other same-day slots on the same day with time overlap
    // 2. Overnight slots whose endDay matches our startDay (carry-over from previous day)
    // 3. Overnight slots starting on our day (e.g., existing Mon 22:00→Tue 02:00 vs new Mon 23:00)
    return {
      ...baseWhere,
      OR: [
        // Same-day overlaps on same startDay
        {
          startDay,
          endDay: startDay,
          OR: [
            { startTimeUtc: { lte: startTimeUtc }, endTimeUtc: { gt: startTimeUtc } },
            { startTimeUtc: { lt: endTimeUtc }, endTimeUtc: { gte: endTimeUtc } },
            { startTimeUtc: { gte: startTimeUtc }, endTimeUtc: { lte: endTimeUtc } },
          ],
        },
        // Overnight slots from previous day carrying into our day
        {
          endDay: startDay,
          NOT: { startDay },
          endTimeUtc: { gt: startTimeUtc },
        },
        // Overnight slots starting on our day whose start time overlaps
        // e.g., existing Mon 22:00→Tue 02:00 vs new Mon 23:00→23:30
        {
          startDay,
          NOT: { endDay: startDay },
          startTimeUtc: { lt: endTimeUtc },
        },
      ],
    };
  } else {
    // Overnight slot: check against
    // 1. Same-day slots on startDay that start at or after our start time
    // 2. Same-day slots on endDay that start before our end time
    // 3. Other overnight slots that overlap on either day
    return {
      ...baseWhere,
      OR: [
        // Same-day slots on our startDay after our start time
        {
          startDay,
          endDay: startDay,
          endTimeUtc: { gt: startTimeUtc },
        },
        // Same-day slots on our endDay before our end time
        {
          startDay: endDay,
          endDay,
          startTimeUtc: { lt: endTimeUtc },
        },
        // Other overnight slots starting on the same day
        {
          startDay,
          NOT: { endDay: startDay },
        },
        // Other overnight slots ending on the same endDay
        {
          endDay,
          NOT: { startDay: endDay },
          endTimeUtc: { gt: 0 },
        },
        // Existing overnight slots whose carry-over day (endDay) is our startDay
        // e.g., existing Mon 22:00→Tue 02:00 vs new Tue 01:00→Wed 03:00
        {
          endDay: startDay,
          NOT: { startDay },
          endTimeUtc: { gt: startTimeUtc },
        },
      ],
    };
  }
}

/**
 * Check whether two weekly slot records overlap in-memory.
 * Works for both same-day and overnight slots.
 *
 * Each slot is described by { startDay, endDay, startTimeUtc, endTimeUtc }
 * where times are minutes-since-midnight-UTC (0-1439).
 *
 * Logic: convert each slot to a set of (day, minuteStart, minuteEnd) ranges,
 * then check for pairwise overlap.
 */
export function slotsOverlap(
  a: { startDay: DayOfWeek; endDay: DayOfWeek; startTimeUtc: number; endTimeUtc: number },
  b: { startDay: DayOfWeek; endDay: DayOfWeek; startTimeUtc: number; endTimeUtc: number },
): boolean {
  // Convert a slot to an array of (dayIndex, startMinute, endMinute) ranges.
  // Same-day slots produce 1 range; overnight slots produce 2 ranges.
  const toRanges = (s: typeof a): Array<[number, number, number]> => {
    const startIdx = DAY_ORDER.indexOf(s.startDay);
    if (s.startDay === s.endDay) {
      return [[startIdx, s.startTimeUtc, s.endTimeUtc]];
    }
    // Overnight: startDay startTimeUtc→1440, endDay 0→endTimeUtc
    const endIdx = DAY_ORDER.indexOf(s.endDay);
    return [
      [startIdx, s.startTimeUtc, 1440],
      [endIdx, 0, s.endTimeUtc],
    ];
  };

  const rangesA = toRanges(a);
  const rangesB = toRanges(b);

  for (const [dayA, startA, endA] of rangesA) {
    for (const [dayB, startB, endB] of rangesB) {
      if (dayA === dayB && startA < endB && startB < endA) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compute the UTC offset in minutes for a given IANA timezone string.
 * Returns the offset such that: localTime = utcTime + offsetMinutes.
 * e.g. "Asia/Kolkata" → 330, "America/New_York" (EST) → -300.
 * Returns 0 on invalid or unrecognised timezone strings.
 */
export function getTimezoneOffsetMinutes(timezone: string): number {
  try {
    const date = new Date();
    const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = date.toLocaleString("en-US", { timeZone: timezone });
    return Math.round(
      (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / 60000,
    );
  } catch {
    return 0;
  }
}

/**
 * Check if a candidate slot fits entirely within a weekly availability window.
 * Handles both same-day and overnight (cross-midnight) availability.
 *
 * Used by: checkout validation, auto-allocator (isWithinAvailability).
 *
 * @param candidateDay - JS getUTCDay() index (0=Sunday..6=Saturday)
 * @param candidateMinutes - Start time as minutes since midnight UTC (0-1439)
 * @param slotDurationMinutes - Duration of the candidate slot in minutes
 * @param availStartDay - DayOfWeek enum string for availability start
 * @param availStartTimeUtc - Availability start in minutes since midnight UTC
 * @param availEndTimeUtc - Availability end in minutes since midnight UTC
 * @param utcOffsetMinutes - UTC offset for the consultant's timezone (e.g. 330
 *   for IST). When provided, enables exact UTC-day matching instead of the heuristic
 *   720-minute guard. Pass null/undefined to fall back to the heuristic path.
 */
export function isMinuteWithinWeeklySlot(
  candidateDay: number,
  candidateMinutes: number,
  slotDurationMinutes: number,
  availStartDay: string,
  availStartTimeUtc: number,
  availEndTimeUtc: number,
  utcOffsetMinutes?: number | null,
): boolean {
  const availDay = DAY_OF_WEEK_TO_INDEX[availStartDay];
  if (availDay === undefined) return false;

  const candidateEndMinutes = candidateMinutes + slotDurationMinutes;
  const isOvernight = availEndTimeUtc <= availStartTimeUtc;

  // === EXACT PATH: use stored timezone offset for precise UTC-day matching ===
  // Eliminates the heuristic 720-minute guard false-positives introduced when
  // a UTC-timezone consultant has afternoon/evening slots (startTimeUtc ≥ 720).
  if (utcOffsetMinutes != null) {
    // availDay is the LOCAL day-of-week. The UTC day of the slot's start may
    // differ when the consultant's midnight isn't aligned with UTC midnight.
    // Formula: utcStartDay = (availDay - floor((startTimeUtc + offset) / 1440)) mod 7
    const localStartMinutes = availStartTimeUtc + utcOffsetMinutes;
    const dayAdjust = Math.floor(localStartMinutes / 1440);
    const utcStartDay = ((availDay - dayAdjust) % 7 + 7) % 7;

    if (!isOvernight) {
      return (
        candidateDay === utcStartDay &&
        candidateMinutes >= availStartTimeUtc &&
        candidateEndMinutes <= availEndTimeUtc
      );
    }

    // Overnight: spans utcStartDay (from startTimeUtc to midnight) then
    // utcEndDay (from midnight to endTimeUtc).
    const utcEndDay = (utcStartDay + 1) % 7;
    if (candidateDay === utcStartDay && candidateMinutes >= availStartTimeUtc) {
      if (candidateEndMinutes <= 1440) return true;
      return candidateEndMinutes - 1440 <= availEndTimeUtc;
    }
    if (candidateDay === utcEndDay && candidateEndMinutes <= availEndTimeUtc) {
      return true;
    }
    return false;
  }

  // === HEURISTIC PATH (legacy): used when utcOffsetMinutes is null ===
  // Applied to slots created before the timezone offset field was added.

  if (!isOvernight) {
    // Same-day availability

    // Direct match: candidate is on the same UTC day as the local day
    if (candidateDay === availDay) {
      return (
        candidateMinutes >= availStartTimeUtc &&
        candidateEndMinutes <= availEndTimeUtc
      );
    }

    // Timezone compensation for non-overnight slots.
    // startDay is the LOCAL day, but candidateDay is the UTC day.
    // They can differ by ±1 depending on the consultant's timezone offset.

    // Positive-offset timezones (IST +5:30, AEST +10, JST +9, etc.):
    // Local midnight maps to late evening UTC on the PREVIOUS day.
    // e.g., Monday 1:00 AM IST = Sunday 19:30 UTC → candidateDay=SUN, availDay=MON
    // Guard: availStartTimeUtc >= 720 (noon UTC) ensures this only applies when
    // UTC times are high enough to result from a positive timezone offset.
    const nextDayFromCandidate = (candidateDay + 1) % 7;
    if (nextDayFromCandidate === availDay && availStartTimeUtc >= 720) {
      if (
        candidateMinutes >= availStartTimeUtc &&
        candidateEndMinutes <= availEndTimeUtc
      ) {
        return true;
      }
    }

    // Negative-offset timezones (EST -5, PST -8, etc.):
    // Late local evening maps to early morning UTC on the NEXT day.
    // e.g., Monday 11:00 PM EST = Tuesday 04:00 UTC → candidateDay=TUE, availDay=MON
    // Guard: availEndTimeUtc <= 720 ensures this only applies when
    // UTC times are low enough to result from a negative timezone offset.
    const prevDayFromCandidate = (candidateDay + 6) % 7;
    if (prevDayFromCandidate === availDay && availEndTimeUtc <= 720) {
      if (
        candidateMinutes >= availStartTimeUtc &&
        candidateEndMinutes <= availEndTimeUtc
      ) {
        return true;
      }
    }

    return false;
  }

  // Overnight availability (e.g., Mon 22:00 → Tue 02:00):
  // Case 1: Candidate on the start day, at or after startTimeUtc
  if (candidateDay === availDay && candidateMinutes >= availStartTimeUtc) {
    if (candidateEndMinutes <= 1440) {
      return true;
    }
    // Slot crosses midnight — verify overflow fits within next-day end
    const overflowMinutes = candidateEndMinutes - 1440;
    return overflowMinutes <= availEndTimeUtc;
  }

  // Case 2: Candidate on the next day, full slot must end at or before endTimeUtc
  const nextDay = (availDay + 1) % 7;
  if (candidateDay === nextDay && candidateEndMinutes <= availEndTimeUtc) {
    return true;
  }

  // Case 3: Timezone compensation for overnight slots

  // 3a: Positive-offset timezone — candidate's UTC day is before the local start day.
  // The overnight in UTC starts on (availDay - 1).
  // e.g., IST Mon 2AM-9AM → UTC Sun 20:30 - Mon 3:30
  //   candidateDay=SUN, availDay=MON, startTimeUtc=1230, endTimeUtc=210
  const nextDayFromCandidateOvn = (candidateDay + 1) % 7;
  if (nextDayFromCandidateOvn === availDay && availStartTimeUtc >= 720) {
    // Start-day portion of the timezone-shifted overnight
    if (candidateMinutes >= availStartTimeUtc) {
      if (candidateEndMinutes <= 1440) return true;
      const overflowMinutes = candidateEndMinutes - 1440;
      if (overflowMinutes <= availEndTimeUtc) return true;
    }
  }

  // 3b: Positive-offset timezone carry-over — candidate is on availDay itself
  // but in the carry-over (early morning UTC) portion.
  // e.g., IST Mon 2AM-9AM → UTC Sun 20:30 - Mon 3:30
  //   candidateDay=MON(1), availDay=MON(1), candidateMinutes=180
  //   Case 1 doesn't match because 180 < startTimeUtc(1230)
  if (
    candidateDay === availDay &&
    candidateMinutes < availStartTimeUtc &&
    availStartTimeUtc >= 720 &&
    candidateEndMinutes <= availEndTimeUtc
  ) {
    return true;
  }

  // 3c: Negative-offset timezone — candidate's UTC day is after the local start day.
  // Only relevant for overnight availability carrying over.
  const prevDayFromCandidateOvn = (candidateDay + 6) % 7;
  if (
    prevDayFromCandidateOvn === availDay &&
    availEndTimeUtc <= 720
  ) {
    if (candidateEndMinutes <= availEndTimeUtc) return true;
  }

  return false;
}
