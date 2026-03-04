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
      ],
    };
  }
}
