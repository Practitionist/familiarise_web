/**
 * #503 — UTC-minutes ↔ consultant-local conversions for weekly availability.
 * The local wall-clock spec (day + minutes + IANA zone) is the DST-proof
 * source of truth; these helpers derive it from the legacy UTC + frozen
 * offset representation at write time.
 */
import type { DayOfWeek } from "@prisma/client";

const DAYS: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

export function toLocalMinutes(
  minutesUtc: number,
  offsetMinutes: number,
): number {
  return (((minutesUtc + offsetMinutes) % 1440) + 1440) % 1440;
}

/**
 * The offset can roll the LOCAL day across midnight relative to the UTC day
 * (review catch on #843): IST 00:30 Monday local is 19:00 Sunday UTC. Local
 * weekly slots are only queryable by local day if that day is stored.
 */
export function toLocalDay(
  utcDay: DayOfWeek,
  minutesUtc: number,
  offsetMinutes: number,
): DayOfWeek {
  const idx = DAYS.indexOf(utcDay);
  const total = minutesUtc + offsetMinutes;
  const dayShift = Math.floor(total / 1440); // -1, 0, or +1
  return DAYS[(((idx + dayShift) % 7) + 7) % 7];
}
