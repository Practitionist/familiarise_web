/**
 * The back office reads every instant in India time, whoever is looking and
 * wherever the code runs. Built on `display.ts` with the zone and the locale
 * pinned, so a server render and the hydrating browser print the same text.
 */

import { formatClockTime, formatDateLabel } from "./display";
import { UTC_ZONE, zoneLabel } from "./viewer-zone";

export const OPERATOR_ZONE = "Asia/Kolkata";

export type OperatorInstantKind = "date" | "time" | "dateTime";

export type Instant = Date | string | number;

const EMPTY = "—";

// India keeps +05:30 all year, so IST wall time and instants convert by plain arithmetic.
const IST_OFFSET_MS = 330 * 60_000;

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATOR_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The IST calendar fields of an instant, read without building a host-local Date. */
function istParts(date: Date): WallParts {
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(PARTS.formatToParts(date).find((p) => p.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
  };
}

/** The instant of an IST wall time; days past the month's end roll over like Date.UTC. */
function istInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS,
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

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

/** How to print a range's end: its time alone on the start's IST day, else its date and time. */
export function operatorEndKind(
  start: Instant,
  end: Instant,
): OperatorInstantKind {
  return formatOperatorInstant(start, "date") ===
    formatOperatorInstant(end, "date")
    ? "time"
    : "dateTime";
}

/** The same instant in UTC, for a tooltip beside the India-time text. */
export function formatUtcInstant(instant: Instant): string {
  const date = toDate(instant);
  return date ? inZone(date, UTC_ZONE, "dateTime") : EMPTY;
}

/** An instant as the IST wall time a datetime-local input shows ("2026-04-01T05:30"); "" for none. */
export function toOperatorWallTime(
  instant: Instant | null | undefined,
): string {
  const date =
    instant === null || instant === undefined ? null : toDate(instant);
  if (!date) return "";
  const p = istParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The instant an IST wall time typed into a datetime-local input names; null when empty or malformed. */
export function fromOperatorWallTime(wall: string): Date | null {
  const match = WALL_TIME.exec(wall);
  if (!match) return null;
  const [year, month, day, hour, minute, second = 0] = match
    .slice(1)
    .map((v) => (v === undefined ? 0 : Number(v)));
  const date = istInstant(year, month, day, hour, minute, second);
  // A field out of range ("2026-02-30", "25:00") would roll over; refuse it instead.
  const back = istParts(date);
  const exact =
    back.year === year &&
    back.month === month &&
    back.day === day &&
    back.hour === hour &&
    back.minute === minute &&
    second < 60;
  return exact ? date : null;
}

/** 00:00 India time on the first of the India-time month that holds `now`. */
export function operatorMonthStart(now: Date): Date {
  const p = istParts(now);
  return istInstant(p.year, p.month, 1);
}

export interface OperatorPeriodStarts {
  /** 00:00 India time today. */
  day: Date;
  /** 00:00 India time on the Sunday that opens this calendar week. */
  week: Date;
  /** 00:00 India time on the first of this month. */
  month: Date;
}

/** The day, week and month starts every operator "today / this week / this month" counts from. */
export function operatorPeriodStarts(now: Date): OperatorPeriodStarts {
  const { year, month, day } = istParts(now);
  // 0 = Sunday, which opens the week as getDay() did; read off the IST date itself.
  const sinceSunday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    day: istInstant(year, month, day),
    week: istInstant(year, month, day - sinceSunday),
    month: istInstant(year, month, 1),
  };
}
