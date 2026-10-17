import type { DayOfWeek } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Projecting a weekly availability row onto real instants.
 *
 * A weekly row means "this local wall-clock window, every week, in this IANA
 * zone": `localStartDay` + `localStartMinutes`..`localEndMinutes` in `timezone`.
 * Each occurrence is materialised per local date through the zone's own rules,
 * so a New York Monday 09:00 row is 13:00Z in summer and 14:00Z in winter.
 *
 * Type-only Prisma import and no server-only modules: the client bundle, jsdom
 * tests and the allocator all share this one generator.
 */

/** DayOfWeek to JS `getUTCDay()` index. */
export const DAY_INDEX: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

/** DayOfWeek values in `getUTCDay()` order. */
export const DAY_BY_INDEX: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;
const MS_PER_WEEK = 7 * MS_PER_DAY;
/** Wider than any UTC offset (±14 h) plus a day, so the probes bracket a whole local date. */
const OFFSET_PROBE_MS = 36 * 60 * MS_PER_MINUTE;

/** JS day index for a DayOfWeek string, or -1 when it is not one. */
export function dayIndexOf(day: string): number {
  const index = (DAY_INDEX as Record<string, number | undefined>)[day];
  return index === undefined ? -1 : index;
}

/** The five DST columns a weekly row is projected from. */
export interface WeeklyRowLocalColumns {
  timezone: string;
  localStartMinutes: number;
  localEndMinutes: number;
  localStartDay: DayOfWeek;
  localEndDay: DayOfWeek;
}

/** The same columns as stored, where every one is nullable. */
export type NullableWeeklyRowLocalColumns = {
  [K in keyof WeeklyRowLocalColumns]: WeeklyRowLocalColumns[K] | null;
};

export interface Interval {
  start: Date;
  end: Date;
}

const knownZones = new Map<string, boolean>();

/** Whether the runtime can resolve `zone` as an IANA time zone. */
export function isKnownTimeZone(zone: string): boolean {
  const cached = knownZones.get(zone);
  if (cached !== undefined) return cached;
  let known = false;
  try {
    formatInTimeZone(0, zone, "xxx");
    known = zone.length > 0;
  } catch {
    known = false;
  }
  knownZones.set(zone, known);
  return known;
}

const OFFSET_TOKEN = /^([+-])(\d{2}):(\d{2})$/;

/** The zone's UTC offset in minutes at one exact instant (local = utc + offset). */
export function zoneOffsetMinutesAt(zone: string, instantMs: number): number {
  const match = OFFSET_TOKEN.exec(formatInTimeZone(instantMs, zone, "xxx"));
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function isMinuteOfDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MINUTES_PER_DAY
  );
}

/** A row is projectable only when all five local columns are present and valid. */
export function hasWeeklyRowLocalColumns<
  T extends NullableWeeklyRowLocalColumns,
>(row: T): row is T & WeeklyRowLocalColumns {
  return (
    typeof row.timezone === "string" &&
    isKnownTimeZone(row.timezone) &&
    row.localStartDay !== null &&
    dayIndexOf(row.localStartDay) !== -1 &&
    row.localEndDay !== null &&
    dayIndexOf(row.localEndDay) !== -1 &&
    isMinuteOfDay(row.localStartMinutes) &&
    isMinuteOfDay(row.localEndMinutes)
  );
}

/** Splits rows into projectable ones and refused ones (NULL or invalid local columns). */
export function partitionWeeklyRows<T extends NullableWeeklyRowLocalColumns>(
  rows: readonly T[],
): { usable: (T & WeeklyRowLocalColumns)[]; refused: T[] } {
  const usable: (T & WeeklyRowLocalColumns)[] = [];
  const refused: T[] = [];
  for (const row of rows) {
    if (hasWeeklyRowLocalColumns(row)) usable.push(row);
    else refused.push(row);
  }
  return { usable, refused };
}

/** The row's end lands on the next local day when it is overnight. */
export function crossesLocalMidnight(
  row: Pick<
    WeeklyRowLocalColumns,
    "localStartDay" | "localEndDay" | "localStartMinutes" | "localEndMinutes"
  >,
): boolean {
  return (
    row.localEndDay !== row.localStartDay ||
    row.localEndMinutes <= row.localStartMinutes
  );
}

/** Published length in local minutes; a DST night can make the real interval differ. */
export function weeklyRowLocalDurationMinutes(
  row: Pick<
    WeeklyRowLocalColumns,
    "localStartDay" | "localEndDay" | "localStartMinutes" | "localEndMinutes"
  >,
): number {
  return crossesLocalMidnight(row)
    ? MINUTES_PER_DAY - row.localStartMinutes + row.localEndMinutes
    : row.localEndMinutes - row.localStartMinutes;
}

/**
 * The instant a local wall-clock time names, given candidate offsets. A time
 * that exists under no candidate (spring-forward gap) is null; one that exists
 * under two (fall-back overlap) resolves to the earlier instant.
 */
function resolveWallClock(
  zone: string,
  wallMs: number,
  offsets: readonly number[],
): number | null {
  let first: number | null = null;
  for (const offset of offsets) {
    const instant = wallMs - offset * MS_PER_MINUTE;
    if (zoneOffsetMinutesAt(zone, instant) !== offset) continue;
    if (first === null || instant < first) first = instant;
  }
  return first;
}

/**
 * One local `[wallStart, wallEnd)` window as UTC instants, or null when either
 * end falls in a spring-forward gap. Equal offsets 36 h either side mean no
 * transition can sit between them, since no zone changes offset twice in 4 days.
 */
function resolveWallWindow(
  zone: string,
  wallStartMs: number,
  wallEndMs: number,
): { startMs: number; endMs: number } | null {
  const before = zoneOffsetMinutesAt(zone, wallStartMs - OFFSET_PROBE_MS);
  const after = zoneOffsetMinutesAt(zone, wallEndMs + OFFSET_PROBE_MS);
  if (before === after) {
    return {
      startMs: wallStartMs - before * MS_PER_MINUTE,
      endMs: wallEndMs - before * MS_PER_MINUTE,
    };
  }
  const offsets = [before, after];
  const startMs = resolveWallClock(zone, wallStartMs, offsets);
  const endMs = resolveWallClock(zone, wallEndMs, offsets);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { startMs, endMs };
}

function isValidRange(rangeStart: Date, rangeEnd: Date): boolean {
  return (
    rangeStart instanceof Date &&
    rangeEnd instanceof Date &&
    !isNaN(rangeStart.getTime()) &&
    !isNaN(rangeEnd.getTime()) &&
    rangeEnd.getTime() > rangeStart.getTime()
  );
}

/**
 * Every occurrence of the row overlapping `[rangeStart, rangeEnd)`, as
 * half-open UTC intervals, one per local date whose weekday is
 * `localStartDay`. The walk starts a local day early so an overnight
 * occurrence that began before the range keeps its tail.
 */
export function weeklyRowIntervalsInRange(
  row: WeeklyRowLocalColumns,
  rangeStart: Date,
  rangeEnd: Date,
): Interval[] {
  const intervals: Interval[] = [];
  if (!isValidRange(rangeStart, rangeEnd)) return intervals;
  const targetDay = dayIndexOf(row.localStartDay);
  if (targetDay === -1 || !isKnownTimeZone(row.timezone)) return intervals;

  const zone = row.timezone;
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  const localDayOf = (instantMs: number) => {
    const wall =
      instantMs + zoneOffsetMinutesAt(zone, instantMs) * MS_PER_MINUTE;
    return Math.floor(wall / MS_PER_DAY) * MS_PER_DAY;
  };
  const endDayOffsetMs = crossesLocalMidnight(row) ? MS_PER_DAY : 0;
  const lastDayMs = localDayOf(rangeEndMs);

  for (
    let dayMs = localDayOf(rangeStartMs) - MS_PER_DAY;
    dayMs <= lastDayMs;
    dayMs += MS_PER_DAY
  ) {
    if (new Date(dayMs).getUTCDay() !== targetDay) continue;
    const window = resolveWallWindow(
      zone,
      dayMs + row.localStartMinutes * MS_PER_MINUTE,
      dayMs + endDayOffsetMs + row.localEndMinutes * MS_PER_MINUTE,
    );
    if (!window) continue;
    if (window.endMs > rangeStartMs && window.startMs < rangeEndMs) {
      intervals.push({
        start: new Date(window.startMs),
        end: new Date(window.endMs),
      });
    }
  }
  return intervals;
}

/** Whether one occurrence of the row contains the whole of `[instantStart, instantEnd)`. */
export function isInstantWithinWeeklyRow(
  row: WeeklyRowLocalColumns,
  instantStart: Date,
  instantEnd: Date,
): boolean {
  const startMs = instantStart.getTime();
  const endMs = instantEnd.getTime();
  return weeklyRowIntervalsInRange(row, instantStart, instantEnd).some(
    (interval) =>
      interval.start.getTime() <= startMs && interval.end.getTime() >= endMs,
  );
}

export interface WeeklyCoverage {
  /** Whether one occurrence of one row contains `[startMs, endMs)`. */
  covers(startMs: number, endMs: number): boolean;
}

/**
 * `isInstantWithinWeeklyRow` over a set of rows, for callers that test many
 * windows: occurrences are projected once per UTC week and reused.
 */
export function createWeeklyCoverage(
  rows: readonly WeeklyRowLocalColumns[],
): WeeklyCoverage {
  const byWeek = new Map<number, [number, number][]>();
  const intervalsForWeek = (week: number): [number, number][] => {
    const cached = byWeek.get(week);
    if (cached) return cached;
    const weekStart = new Date(week * MS_PER_WEEK);
    const weekEnd = new Date((week + 1) * MS_PER_WEEK);
    const intervals = rows.flatMap((row) =>
      weeklyRowIntervalsInRange(row, weekStart, weekEnd).map(
        (i): [number, number] => [i.start.getTime(), i.end.getTime()],
      ),
    );
    byWeek.set(week, intervals);
    return intervals;
  };
  return {
    covers(startMs, endMs) {
      if (rows.length === 0 || !(endMs > startMs)) return false;
      return intervalsForWeek(Math.floor(startMs / MS_PER_WEEK)).some(
        ([start, end]) => start <= startMs && end >= endMs,
      );
    },
  };
}

/**
 * The calendar date the weekly save path converts local times on. Every stored
 * `startTimeUtc`/`endTimeUtc` is the typed wall clock minus the zone's offset on
 * this date, so that offset (not today's) recovers what the consultant typed.
 */
export const WEEKLY_SAVE_PROBE_DATE = "1970-01-01";
const WEEKLY_SAVE_PROBE_MS = Date.UTC(1970, 0, 1, 12);

/** The zone's offset on `WEEKLY_SAVE_PROBE_DATE`. */
export function weeklySaveProbeOffsetMinutes(zone: string): number {
  return isKnownTimeZone(zone)
    ? zoneOffsetMinutesAt(zone, WEEKLY_SAVE_PROBE_MS)
    : 0;
}

/** Minimal weekly shape the writers hand over: the local day plus UTC minutes. */
export interface WeeklyRowTimes {
  startDay: DayOfWeek;
  endDay?: DayOfWeek;
  startTimeUtc: number;
  endTimeUtc: number;
}

const toMinuteOfDay = (minutes: number) =>
  ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

/**
 * The five DST columns for a row about to be written. `offsetMinutes` must be
 * the offset its UTC minutes were derived with (`weeklySaveProbeOffsetMinutes`
 * for the save path). `startDay` is already the consultant's local day.
 */
export function weeklyRowLocalColumns(
  row: WeeklyRowTimes,
  timezone: string,
  offsetMinutes: number,
): WeeklyRowLocalColumns {
  const localStartMinutes = toMinuteOfDay(row.startTimeUtc + offsetMinutes);
  const localEndMinutes = toMinuteOfDay(row.endTimeUtc + offsetMinutes);
  const startIndex = dayIndexOf(row.startDay);
  const endIndex =
    startIndex === -1
      ? -1
      : localEndMinutes <= localStartMinutes
        ? (startIndex + 1) % 7
        : startIndex;
  return {
    timezone,
    localStartMinutes,
    localEndMinutes,
    localStartDay: row.startDay,
    localEndDay: DAY_BY_INDEX[endIndex] ?? row.startDay,
  };
}

/**
 * The inverse of `weeklyRowLocalColumns`: the UTC writer columns for a row
 * whose local columns are authoritative. `endDay` records a UTC-midnight
 * crossing, which is what the overlap SQL and `validateWeeklySlotTimeOrder` read.
 */
export function weeklyWriterColumnsFromLocal(
  local: Pick<
    WeeklyRowLocalColumns,
    "localStartDay" | "localStartMinutes" | "localEndMinutes"
  >,
  offsetMinutes: number,
): Required<WeeklyRowTimes> {
  const startTimeUtc = toMinuteOfDay(local.localStartMinutes - offsetMinutes);
  const endTimeUtc = toMinuteOfDay(local.localEndMinutes - offsetMinutes);
  const startIndex = dayIndexOf(local.localStartDay);
  return {
    startDay: local.localStartDay,
    endDay:
      endTimeUtc <= startTimeUtc && startIndex !== -1
        ? DAY_BY_INDEX[(startIndex + 1) % 7]
        : local.localStartDay,
    startTimeUtc,
    endTimeUtc,
  };
}
