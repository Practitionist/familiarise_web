/**
 * The zone a time grid is DRAWN in, and the rows it draws.
 *
 * The display zone is the viewer's profile zone (the one the appointment
 * pages and emails use), switchable to the device zone. Rows are generated
 * per calendar day from the zone's own rules: a spring-forward day has fewer
 * rows, a fall-back day repeats an hour ("1:00 am (2nd)"), and every row is a
 * 30-minute UTC atom, so a +05:45 viewer sees 9:15–9:45 rather than cells
 * that never match a server atom.
 *
 * Calendar dates travel as local-noon `Date`s (date-fns's week helpers need
 * them); only their year/month/day fields are read, never their instant.
 */
import { fromZonedTime, getTimezoneOffset } from "date-fns-tz";

import { DISPLAY_LOCALE } from "@/lib/time/display";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";

import {
  zoneDisplayLabel,
  canonicalZone,
  isValidTimeZone,
} from "./viewer-zone";

export const ATOM_MS = 30 * 60 * 1000;

/** Local minutes past :00/:30 where `zone`'s UTC atoms start at `at`: 15 at +05:45, else 0. */
export function atomPhaseMinutes(zone: string, at: Date): number {
  const offsetMinutes = getTimezoneOffset(zone, at) / 60_000;
  return ((offsetMinutes % 30) + 30) % 30;
}

/** The profile zone when it is valid and the viewer has not switched, else the device's. */
export function resolveGridZone(
  profileZone: string | null | undefined,
  deviceZone: string,
  useDeviceZone = false,
): string {
  if (useDeviceZone) return deviceZone;
  return isValidTimeZone(profileZone) ? profileZone : deviceZone;
}

/** True when offering "Use my device's time zone" would change anything. */
export function canSwitchToDeviceZone(
  profileZone: string | null | undefined,
  deviceZone: string,
): boolean {
  return (
    isValidTimeZone(profileZone) &&
    canonicalZone(profileZone) !== canonicalZone(deviceZone)
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `yyyy-MM-dd` of a local-noon calendar date. */
export function calendarDateKey(day: Date): string {
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * The instant at `hour:minute` on the calendar date of `day`, read in `zone`.
 * Built from a zone-less string, never a browser-local `Date`, so the
 * device's own DST cannot move it. A wall time inside a spring-forward gap
 * resolves to the earlier offset's instant.
 */
export function cellInstant(
  day: Date,
  hour: number,
  minute: number,
  zone: string,
): Date {
  return fromZonedTime(
    `${calendarDateKey(day)}T${pad(hour)}:${pad(minute)}:00`,
    zone,
  );
}

const MINUTE_MS = 60 * 1000;

/**
 * The first instant of the calendar date `day` in `zone`. Where the clocks
 * spring forward at midnight (Santiago, Havana, Cairo) local 00:00 does not
 * exist, so this is the transition itself: the first minute whose wall date
 * is `day`.
 */
export function dayStartInstant(day: Date, zone: string): Date {
  const candidate = cellInstant(day, 0, 0, zone);
  if (isOnCalendarDay(day, candidate, zone)) return candidate;
  // The candidate fell on the previous evening; no zone skips more than 3 h.
  let low = candidate.getTime();
  let high = low + 3 * 60 * MINUTE_MS;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (isOnCalendarDay(day, new Date(middle), zone)) high = middle;
    else low = middle;
  }
  return new Date(high);
}

function nextCalendarDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 12);
}

/**
 * The half-open [first instant, next day's first instant) of the calendar days
 * `from`..`to`, in `zone`. Exclusive, so the last half-hour of `to` is a whole atom.
 */
export function dayRangeBounds(
  from: Date,
  to: Date,
  zone: string,
): { start: Date; end: Date } {
  return {
    start: dayStartInstant(from, zone),
    end: dayStartInstant(nextCalendarDay(to), zone),
  };
}

/** One 30-minute UTC atom on one calendar day of the display zone. */
export interface GridRow {
  /** `${minuteOfDay}` or `${minuteOfDay}#2` for a repeated fall-back time. */
  key: string;
  start: Date;
  end: Date;
  /** Wall-clock minutes since local midnight of the atom's start. */
  minuteOfDay: number;
  /** 0 for the first time a wall clock occurs that day, 1 for the repeat. */
  occurrence: 0 | 1;
  /** "9:15 am", or "1:00 am (2nd)" for the repeat. */
  label: string;
}

function rowKey(minuteOfDay: number, occurrence: 0 | 1): string {
  return occurrence === 0 ? String(minuteOfDay) : `${minuteOfDay}#2`;
}

/**
 * Every atom whose start falls on the calendar date `day` in `zone`, in
 * order: 48 on a normal day, 46 or 50 across an hour shift, 47 or 49 across
 * a half-hour shift. Atoms sit on the UTC :00/:30 grid whatever the offset.
 */
export function dayRows(day: Date, zone: string): GridRow[] {
  const startMs = dayStartInstant(day, zone).getTime();
  const endMs = dayStartInstant(nextCalendarDay(day), zone).getTime();
  // One formatter pair per day, not per row: Intl construction dominates.
  const clockFormat = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  });
  const partsFormat = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  });
  const seen = new Set<number>();
  const rows: GridRow[] = [];
  for (
    let atom = Math.ceil(startMs / ATOM_MS) * ATOM_MS;
    atom < endMs;
    atom += ATOM_MS
  ) {
    const start = new Date(atom);
    const parts = partsFormat.formatToParts(start);
    const hour = Number(parts.find((part) => part.type === "hour")?.value) % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    const minuteOfDay = hour * 60 + minute;
    const occurrence: 0 | 1 = seen.has(minuteOfDay) ? 1 : 0;
    seen.add(minuteOfDay);
    const clock = clockFormat.format(start);
    rows.push({
      key: rowKey(minuteOfDay, occurrence),
      start,
      end: new Date(atom + ATOM_MS),
      minuteOfDay,
      occurrence,
      label: occurrence === 0 ? clock : `${clock} (2nd)`,
    });
  }
  return rows;
}

/** One row of a week grid: a wall-clock time that at least one day has. */
export interface AxisRow {
  key: string;
  minuteOfDay: number;
  occurrence: 0 | 1;
  label: string;
}

export interface WeekRowModel {
  axis: AxisRow[];
  /** Per day (same order as `days`), axis key → that day's atom; absent on a skipped time. */
  cells: Map<string, GridRow>[];
}

/**
 * The union of the days' wall-clock rows in time order: each day's own
 * sequence is merged in, so a fall-back repeat sits where it happens (1:00,
 * 1:30, 1:00 (2nd), 1:30 (2nd)) and a day without a given row (the hour a
 * spring-forward skips, or another day's repeat) simply has no cell there.
 */
export function weekRowModel(
  days: readonly Date[],
  zone: string,
): WeekRowModel {
  const axis: AxisRow[] = [];
  const seen = new Set<string>();
  const cells = days.map((day) => {
    const byKey = new Map<string, GridRow>();
    let previousKey: string | null = null;
    for (const row of dayRows(day, zone)) {
      byKey.set(row.key, row);
      if (!seen.has(row.key)) {
        seen.add(row.key);
        const entry: AxisRow = {
          key: row.key,
          minuteOfDay: row.minuteOfDay,
          occurrence: row.occurrence,
          label: row.label,
        };
        const at =
          previousKey === null
            ? insertionIndex(axis, row.minuteOfDay)
            : axis.findIndex((axisRow) => axisRow.key === previousKey) + 1;
        axis.splice(at, 0, entry);
      }
      previousKey = row.key;
    }
    return byKey;
  });
  return { axis, cells };
}

/** Where a day's first row goes: before the first first-occurrence row after it. */
function insertionIndex(axis: readonly AxisRow[], minuteOfDay: number): number {
  const index = axis.findIndex(
    (row) => row.occurrence === 0 && row.minuteOfDay > minuteOfDay,
  );
  return index === -1 ? axis.length : index;
}

/** The atom an instant sits in, and how far into it. */
export function atomOf(instant: Date): { start: Date; fraction: number } {
  const startMs = Math.floor(instant.getTime() / ATOM_MS) * ATOM_MS;
  return {
    start: new Date(startMs),
    fraction: (instant.getTime() - startMs) / ATOM_MS,
  };
}

/** The axis index of the first row at or after the wall clock of `instant` in `zone`. */
export function axisIndexAt(
  axis: readonly AxisRow[],
  instant: Date,
  zone: string,
): number {
  if (axis.length === 0) return 0;
  const { hour, minute } = ScheduleCalculationService.wallClock(instant, zone);
  const target = hour * 60 + minute;
  let index = axis.findIndex((row) => row.minuteOfDay + 30 > target);
  if (index === -1) index = axis.length - 1;
  return index;
}

/** The calendar date of an instant in `zone`, as a local-noon `Date` the grid can key on. */
export function calendarDayOf(instant: Date, zone: string): Date {
  const { year, month, day } = ScheduleCalculationService.wallClock(
    instant,
    zone,
  );
  return new Date(year, month - 1, day, 12);
}

/** True when `instant` falls on the calendar date `day` as read in `zone`. */
export function isOnCalendarDay(
  day: Date,
  instant: Date,
  zone: string,
): boolean {
  const {
    year,
    month,
    day: dayOfMonth,
  } = ScheduleCalculationService.wallClock(instant, zone);
  return (
    day.getFullYear() === year &&
    day.getMonth() === month - 1 &&
    day.getDate() === dayOfMonth
  );
}

export interface FooterZoneLine {
  /** "Times shown in IST (UTC+05:30)". */
  label: string;
  /** The canonical IANA name, for the span's title. */
  title: string;
  /** " · Limits counted in …", only when the caps bucket in another zone. */
  limits: { label: string; title: string } | null;
}

/** The grid's zone line, from the zone the grid is drawn in — never from `Intl`. */
export function footerZoneLine(
  now: Date,
  gridZone: string,
  schedulingZone?: string | null,
): FooterZoneLine {
  const limits =
    schedulingZone && canonicalZone(schedulingZone) !== canonicalZone(gridZone)
      ? {
          label: `Limits counted in ${zoneDisplayLabel(now, schedulingZone)}`,
          title: canonicalZone(schedulingZone),
        }
      : null;
  return {
    label: `Times shown in ${zoneDisplayLabel(now, gridZone)}`,
    title: canonicalZone(gridZone),
    limits,
  };
}
