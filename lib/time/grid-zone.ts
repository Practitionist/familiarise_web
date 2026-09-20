/**
 * The zone the week grid is DRAWN in (#1703 QA-1).
 *
 * Every cell is a wall-clock (calendar date, hour, minute) that must become
 * an instant, and every instant on the page (now, a selected slot, a focus
 * target) must become a row and a column. Both directions go through the
 * viewer's profile zone — the same one the Appointments pages and the
 * confirm dialog render in — so Ethan in America/Bahia no longer sees an IST
 * grid over a Bahia dialog. The browser zone is the fallback only when the
 * profile has none.
 *
 * Calendar dates travel as local-noon `Date`s (date-fns's week helpers need
 * them); only their year/month/day are read, never their instant.
 */
import { fromZonedTime } from "date-fns-tz";

import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";

import {
  zoneDisplayLabel,
  canonicalZone,
  isValidTimeZone,
} from "./viewer-zone";

/** One zone source: the profile zone when it is valid, else the browser's. */
export function resolveGridZone(
  viewerZone: string | null | undefined,
  browserZone: string,
): string {
  return isValidTimeZone(viewerZone) ? viewerZone : browserZone;
}

/** The instant at `hour:minute` on the calendar date of `day`, read in `zone`. */
export function cellInstant(
  day: Date,
  hour: number,
  minute: number,
  zone: string,
): Date {
  return fromZonedTime(
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute),
    zone,
  );
}

/** The half-open [first instant, last ms] of the calendar days `from`..`to`, in `zone`. */
export function dayRangeBounds(
  from: Date,
  to: Date,
  zone: string,
): { start: Date; end: Date } {
  const next = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return {
    start: cellInstant(from, 0, 0, zone),
    end: new Date(cellInstant(next, 0, 0, zone).getTime() - 1),
  };
}

/** The row an instant sits on in `zone`, and how far into that row. */
export function rowOf(
  instant: Date,
  zone: string,
): { rowIndex: number; fraction: number } {
  const { hour, minute } = ScheduleCalculationService.wallClock(instant, zone);
  return {
    rowIndex: hour * 2 + (minute >= 30 ? 1 : 0),
    fraction: (minute % 30) / 30,
  };
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
  /** "Times in IST (UTC+05:30)". */
  label: string;
  /** The canonical IANA name, for the span's title. */
  title: string;
  /** " · Limits counted in …", only when the caps bucket in another zone. */
  limits: { label: string; title: string } | null;
}

/**
 * The grid footer's zone line, from the zone the grid is drawn in — never
 * from `Intl` directly, which is how the footer drifted to the browser zone
 * while every other surface showed the profile zone.
 */
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
    label: `Times in ${zoneDisplayLabel(now, gridZone)}`,
    title: canonicalZone(gridZone),
    limits,
  };
}
