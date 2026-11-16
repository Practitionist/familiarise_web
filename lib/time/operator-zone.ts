/**
 * The back office reads every instant in India time, whoever is looking and
 * wherever the code runs. Built on `display.ts` with the zone and the locale
 * pinned, so a server render and the hydrating browser print the same text.
 */

import { fromZonedTime } from "date-fns-tz";

import { formatClockTime, formatDateLabel } from "./display";
import { formatInViewerZone, UTC_ZONE, zoneLabel } from "./viewer-zone";

export const OPERATOR_ZONE = "Asia/Kolkata";

export type OperatorInstantKind = "date" | "time" | "dateTime";

export type Instant = Date | string | number;

const EMPTY = "—";

function toDate(instant: Instant): Date | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inZone(date: Date, zone: string, kind: OperatorInstantKind): string {
  const opts = { zone };
  if (kind === "date") return formatDateLabel(date, opts);
  const clock = `${formatClockTime(date, opts)} ${zoneLabel(date, zone)}`;
  return kind === "time" ? clock : `${formatDateLabel(date, opts)}, ${clock}`;
}

/** "24 Sep 2026" / "2:00 pm IST" / "24 Sep 2026, 2:00 pm IST"; "—" for no instant. */
export function formatOperatorInstant(
  instant: Instant,
  kind: OperatorInstantKind = "dateTime",
): string {
  const date = toDate(instant);
  return date ? inZone(date, OPERATOR_ZONE, kind) : EMPTY;
}

/** The same instant in UTC, for a tooltip beside the India-time text. */
export function formatUtcInstant(instant: Instant): string {
  const date = toDate(instant);
  return date ? inZone(date, UTC_ZONE, "dateTime") : EMPTY;
}

/** 00:00 India time on the first of the India-time month that holds `now`. */
export function operatorMonthStart(now: Date): Date {
  const month = formatInViewerZone(now, OPERATOR_ZONE, "yyyy-MM");
  return fromZonedTime(`${month}-01T00:00:00`, OPERATOR_ZONE);
}

export interface OperatorPeriodStarts {
  /** 00:00 India time today. */
  day: Date;
  /** 00:00 India time on the Sunday that opens this calendar week. */
  week: Date;
  /** 00:00 India time on the first of this month. */
  month: Date;
}

const midnightIn = (wallDate: string) =>
  fromZonedTime(`${wallDate}T00:00:00`, OPERATOR_ZONE);

/** The day, week and month starts every operator "today / this week / this month" counts from. */
export function operatorPeriodStarts(now: Date): OperatorPeriodStarts {
  const today = formatInViewerZone(now, OPERATOR_ZONE, "yyyy-MM-dd");
  const [y, m, d] = today.split("-").map(Number);
  // ISO weekday 1 (Mon) to 7 (Sun); Sunday opens the week, as getDay() did.
  const sinceSunday = Number(formatInViewerZone(now, OPERATOR_ZONE, "i")) % 7;
  const sunday = new Date(Date.UTC(y, m - 1, d - sinceSunday));
  return {
    day: midnightIn(today),
    week: midnightIn(sunday.toISOString().slice(0, 10)),
    month: operatorMonthStart(now),
  };
}
