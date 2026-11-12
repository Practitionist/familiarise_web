/**
 * The shape of a booking's schedule as the detail page draws it: sessions in
 * start order, split into past and upcoming, grouped into weeks of the
 * viewer's calendar, with the facts a reader would otherwise have to work out
 * (empty weeks, short weeks, two sessions on one day, mixed lengths).
 *
 * Pure and zone-explicit: every calendar question is answered in `zone`, so a
 * server render and the browser agree and a week never splits at the
 * runtime's midnight.
 */

import { formatInTimeZone } from "date-fns-tz";

const DAY_MS = 86_400_000;

export interface ScheduleSessionInput {
  key: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ScheduleSession<T extends ScheduleSessionInput> {
  session: T;
  /** 1-based position among every session in the list. */
  number: number;
  /** `yyyy-MM-dd` in the zone. */
  localDay: string;
  minutes: number;
  /** Another session in the list starts on the same local day. */
  sharesDay: boolean;
}

export interface ScheduleWeek<T extends ScheduleSessionInput> {
  /** 1-based, counted from the first session's local day. */
  week: number;
  /** Local `yyyy-MM-dd` of the week's first and last day. */
  firstDay: string;
  lastDay: string;
  sessions: ScheduleSession<T>[];
  /** Fewer sessions than the plan's weekly count (only when one is given). */
  short: boolean;
}

export interface ScheduleModel<T extends ScheduleSessionInput> {
  sessions: ScheduleSession<T>[];
  /** Weeks from the first to the last session, empty weeks included. */
  weeks: ScheduleWeek<T>[];
  /** Session lengths differ, so each row names its own length. */
  mixedLengths: boolean;
  /** More than one week holds sessions, so grouping by week helps. */
  multiWeek: boolean;
}

/** Whole days between two local `yyyy-MM-dd` strings (b − a). */
function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function buildScheduleModel<T extends ScheduleSessionInput>(
  input: readonly T[],
  zone: string,
  opts: { sessionsPerWeek?: number | null } = {},
): ScheduleModel<T> {
  const sorted = [...input].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const days = sorted.map((s) =>
    formatInTimeZone(s.startsAt, zone, "yyyy-MM-dd"),
  );
  const perDay = new Map<string, number>();
  for (const d of days) perDay.set(d, (perDay.get(d) ?? 0) + 1);

  const sessions = sorted.map((session, i) => ({
    session,
    number: i + 1,
    localDay: days[i],
    minutes: Math.round(
      (session.endsAt.getTime() - session.startsAt.getTime()) / 60_000,
    ),
    sharesDay: (perDay.get(days[i]) ?? 0) > 1,
  }));

  const weeks: ScheduleWeek<T>[] = [];
  if (sessions.length > 0) {
    const first = sessions[0].localDay;
    const lastWeek =
      Math.floor(dayDiff(first, sessions.at(-1)!.localDay) / 7) + 1;
    for (let w = 1; w <= lastWeek; w++) {
      weeks.push({
        week: w,
        firstDay: addDays(first, (w - 1) * 7),
        lastDay: addDays(first, (w - 1) * 7 + 6),
        sessions: [],
        short: false,
      });
    }
    for (const s of sessions) {
      weeks[Math.floor(dayDiff(first, s.localDay) / 7)].sessions.push(s);
    }
    const perWeek = opts.sessionsPerWeek ?? 0;
    if (perWeek > 0) {
      for (const w of weeks) w.short = w.sessions.length < perWeek;
    }
  }

  return {
    sessions,
    weeks,
    mixedLengths: new Set(sessions.map((s) => s.minutes)).size > 1,
    multiWeek: weeks.filter((w) => w.sessions.length > 0).length > 1,
  };
}

/** "16–22 Nov", or "28 Nov – 4 Dec" across a month end. */
export function weekRangeLabel(firstDay: string, lastDay: string): string {
  const a = new Date(`${firstDay}T12:00:00Z`);
  const b = new Date(`${lastDay}T12:00:00Z`);
  const sameMonth = firstDay.slice(0, 7) === lastDay.slice(0, 7);
  return sameMonth
    ? `${formatInTimeZone(a, "UTC", "d")}–${formatInTimeZone(b, "UTC", "d MMM")}`
    : `${formatInTimeZone(a, "UTC", "d MMM")} – ${formatInTimeZone(b, "UTC", "d MMM")}`;
}

/** "60 min", "1 h 30 min", "2 h". */
export function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * "9:00 – 10:30 AM", or "11:30 AM – 12:30 PM" when the range crosses noon, so
 * a start is never read in the wrong half of the day.
 */
export function timeRangeLabel(
  format: (date: Date, pattern: string) => string,
  start: Date,
  end: Date,
): string {
  const sameHalf = format(start, "a") === format(end, "a");
  return `${format(start, sameHalf ? "h:mm" : "h:mm a")} – ${format(end, "h:mm a")}`;
}
