/**
 * One instant printed in one named zone, for surfaces that both operators and
 * customers see (support). India time goes through the operator helper, which
 * names it IST; any other zone goes through `display.ts` (Intl only), and UTC
 * is named so a fallback zone is never read as the viewer's own. Pure.
 */

import {
  formatClockTime,
  formatDateLabel,
  formatDateTimeLabel,
  type DisplayOpts,
} from "./display";
import {
  formatOperatorInstant,
  formatUtcInstant,
  OPERATOR_ZONE,
} from "./operator-zone";
import { canonicalZone, UTC_ZONE } from "./viewer-zone";

export type ClockInstant = Date | string | number;

export interface ZoneClock {
  zone: string;
  /** "24 Sept 2026, 2:00 pm" (IST and UTC say so). */
  dateTime: (at: ClockInstant) => string;
  /** "24 Sept 2026". */
  date: (at: ClockInstant) => string;
  /** "2:00 pm" (IST and UTC say so). */
  time: (at: ClockInstant) => string;
  /** "24 Sept": the day and month alone. */
  dayMonth: (at: ClockInstant) => string;
  /** The calendar day of an instant in this zone, "2026-09-24", for same-day tests. */
  dayKey: (at: ClockInstant) => string;
  /** The exact UTC reading for a hover, on the operator clock only (D3); null elsewhere. */
  exactTitle: (at: ClockInstant) => string | null;
}

const EMPTY = "—";

function toDate(at: ClockInstant): Date | null {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

const guard =
  (format: (date: Date) => string) =>
  (at: ClockInstant): string => {
    const date = toDate(at);
    return date ? format(date) : EMPTY;
  };

/** The clock for `zone`; India time is IST, UTC is labelled, any other zone prints bare. */
export function zoneClock(zone: string): ZoneClock {
  const canonical = canonicalZone(zone);
  const opts: DisplayOpts = { zone: canonical };
  const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: canonical,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayMonthFormat = new Intl.DateTimeFormat("en-IN", {
    timeZone: canonical,
    day: "numeric",
    month: "short",
  });
  const dayKey = guard((d) => dayKeyFormat.format(d));
  const dayMonth = guard((d) => dayMonthFormat.format(d));
  if (canonical === OPERATOR_ZONE) {
    return {
      zone: canonical,
      dateTime: (at) => formatOperatorInstant(at, "dateTime"),
      date: (at) => formatOperatorInstant(at, "date"),
      time: (at) => formatOperatorInstant(at, "time"),
      dayMonth,
      dayKey,
      exactTitle: (at) => formatUtcInstant(at),
    };
  }
  const suffix = canonical === UTC_ZONE ? " UTC" : "";
  return {
    zone: canonical,
    dateTime: guard((d) => `${formatDateTimeLabel(d, opts)}${suffix}`),
    date: guard((d) => formatDateLabel(d, opts)),
    time: guard((d) => `${formatClockTime(d, opts)}${suffix}`),
    dayMonth,
    dayKey,
    exactTitle: () => null,
  };
}
