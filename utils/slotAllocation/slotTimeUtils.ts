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
 * Extract minutes-since-midnight from a Date object (UTC)
 * Useful when converting from Date-based slot representations.
 *
 * @param date - Date to extract time from
 * @returns Minutes since midnight UTC (0-1439)
 */
export function dateToMinuteUtc(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}
