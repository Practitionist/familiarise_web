// Projects weekly and custom availability rows onto the days the search walks.

import { weeklyRowIntervalsInRange } from "@/utils/schedule/weekly-projection";
import {
  type ProjectableWeeklyRow,
  DAY_MS,
} from "@/lib/booking/allocation/search/constants";

/** Weekly rows ordered by their next occurrence after `now`; rows with none sort last. */
export function sortWeeklyByNextOccurrence(
  rows: ProjectableWeeklyRow[],
  now: Date,
): ProjectableWeeklyRow[] {
  const horizon = new Date(now.getTime() + 15 * DAY_MS);
  const nextStart = (row: ProjectableWeeklyRow) =>
    weeklyRowIntervalsInRange(row, now, horizon)
      .find((occurrence) => occurrence.start > now)
      ?.start.getTime() ?? Number.POSITIVE_INFINITY;
  return rows
    .map((row) => ({ row, next: nextStart(row) }))
    .sort((a, b) => a.next - b.next)
    .map(({ row }) => row);
}

/**
 * Match a custom slot to a specific target day.
 */
export function matchCustomSlotToDay(
  slotTime: Date,
  targetDay: Date,
): Date | null {
  const slotDate = new Date(slotTime);
  // Use ISO date string for reliable comparison (always YYYY-MM-DD format).
  // Previous code used getUTCMonth() (0-indexed) without padding, which was fragile.
  const slotDateStr = slotDate.toISOString().split("T")[0];
  const targetDateStr = targetDay.toISOString().split("T")[0];

  if (slotDateStr === targetDateStr) {
    return new Date(slotTime);
  }
  return null;
}
