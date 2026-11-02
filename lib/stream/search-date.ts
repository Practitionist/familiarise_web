/**
 * Turn a chat-search term into the calendar day(s) it names, in the viewer's zone.
 *
 * Only unambiguous forms count — `2026-11-03`, `3 nov`, `nov 3`, `3rd November 2026`,
 * `today`, `tomorrow`, `yesterday`. A bare month name or a numeric `3/11` is NOT a
 * date here: "may" and "mar" are also names, and day/month order differs by reader.
 *
 * Pure: `now` and `timeZone` are arguments, so the result depends on nothing else.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** One local calendar day as a half-open UTC interval. */
export interface DayRange {
  start: Date;
  end: Date;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const RELATIVE_DAYS: Record<string, number> = {
  yesterday: -1,
  today: 0,
  tomorrow: 1,
};

const ISO_DAY = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/;
const DAY_FIRST = /^(\d{1,2}) ([a-z]+)(?: (20\d{2}))?$/;
const MONTH_FIRST = /^([a-z]+) (\d{1,2})(?: (20\d{2}))?$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Whether y-m-d is a real calendar day (rejects 31 Feb, which `Date.UTC` would roll over). */
function isRealDay({ y, m, d }: Ymd): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

function addDays({ y, m, d }: Ymd, days: number): Ymd {
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

function localMidnight({ y, m, d }: Ymd, timeZone: string): Date {
  return fromZonedTime(`${y}-${pad(m)}-${pad(d)}T00:00:00`, timeZone);
}

function dayRange(day: Ymd, timeZone: string): DayRange {
  return {
    start: localMidnight(day, timeZone),
    end: localMidnight(addDays(day, 1), timeZone),
  };
}

function today(now: Date, timeZone: string): Ymd {
  const [y, m, d] = formatInTimeZone(now, timeZone, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  return { y, m, d };
}

/** The month word, day and optional year of "3 nov [2026]" or "nov 3 [2026]". */
function dateParts(text: string): {
  month?: string;
  day?: string;
  year?: string;
} {
  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) {
    return { day: dayFirst[1], month: dayFirst[2], year: dayFirst[3] };
  }
  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst) {
    return { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] };
  }
  return {};
}

/**
 * The days `term` names, or `[]` when it is not a date.
 *
 * With no year given the day is returned for the year before, the current year
 * and the year after: a search for "3 jan" in October is as likely to be last
 * January's completed session as next January's booking.
 */
export function parseSearchDays(
  term: string,
  now: Date,
  timeZone: string,
): DayRange[] {
  const text = term
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  // Own keys only: "constructor" and "__proto__" must not read as dates.
  const relative = Object.hasOwn(RELATIVE_DAYS, text)
    ? RELATIVE_DAYS[text]
    : undefined;
  if (relative !== undefined) {
    return [dayRange(addDays(today(now, timeZone), relative), timeZone)];
  }

  const iso = ISO_DAY.exec(text);
  if (iso) {
    const day = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
    return isRealDay(day) ? [dayRange(day, timeZone)] : [];
  }

  const { month: monthWord, day: dayWord, year: yearWord } = dateParts(text);
  const month =
    monthWord && Object.hasOwn(MONTHS, monthWord)
      ? MONTHS[monthWord]
      : undefined;
  if (!month || !dayWord) return [];

  const years = yearWord
    ? [Number(yearWord)]
    : [-1, 0, 1].map((offset) => today(now, timeZone).y + offset);
  return years
    .map((y) => ({ y, m: month, d: Number(dayWord) }))
    .filter(isRealDay)
    .map((day) => dayRange(day, timeZone));
}
