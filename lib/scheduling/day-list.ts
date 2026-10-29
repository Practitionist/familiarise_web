/**
 * The mobile day list's model: which session starts each of the next days
 * offers, read from the same grid answer the desktop heat map paints.
 *
 * A start is offered only when every 30-minute atom the session covers is
 * free (`available`, not too soon, not over a plan limit), it is not inside
 * the checkout lead time or the caller's extra notice, and the whole session
 * sits inside the allowed window. Days are calendar dates of the display
 * zone; a start belongs to the day its first atom is keyed under.
 */
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import {
  formatClockTime,
  formatDayLabel,
  formatDayOfMonth,
  formatWeekdayShort,
} from "@/lib/time/display";
import {
  ATOM_MS,
  calendarDateKey,
  calendarDayOf,
  dayRangeBounds,
} from "@/lib/time/grid-zone";

/** The part of a grid atom the day list reads. */
export interface DayListAtom {
  startsAt: string;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  tooSoon?: boolean;
  limitReached?: boolean;
}

/** One whole-session pick, ISO instants. */
export interface DayListPick {
  startsAt: string;
  endsAt: string;
}

export interface DayListStart extends DayListPick {
  /** "9:30 am – 10:30 am" in the display zone. */
  label: string;
}

export interface DayListDay {
  /** `yyyy-MM-dd` in the display zone. */
  key: string;
  /** "Thu". */
  weekday: string;
  /** "24". */
  dayOfMonth: string;
  /** "Thu 24 Sep", for the chip's accessible name. */
  label: string;
  starts: DayListStart[];
}

export interface DayListRules {
  zone: string;
  /** Length of each session; a multiple of 30. */
  sessionMinutes: number;
  nowMs: number;
  /** Selectable window, inclusive start. */
  allowedStart?: Date;
  /** Selectable window, inclusive end of the last session. */
  allowedEnd?: Date;
  /** Notice the caller requires on top of the checkout lead time. */
  minLeadHours?: number;
}

export const DAY_LIST_DAYS = 14;

/** Why an unpicked start cannot join the current picks, or null when it can. */
export type PickConflict = "overlap" | "dayFull";

/**
 * A start that overlaps a pick (the same half-hour twice) or would put more
 * sessions on one scheduling-zone day than the plan allows cannot be added.
 */
export function pickConflict(
  candidate: DayListPick,
  picks: readonly DayListPick[],
  dayCap?: { perDay: number; zone: string },
): PickConflict | null {
  const startMs = new Date(candidate.startsAt).getTime();
  const endMs = new Date(candidate.endsAt).getTime();
  const others = picks.filter((pick) => pick.startsAt !== candidate.startsAt);
  if (
    others.some(
      (pick) =>
        new Date(pick.startsAt).getTime() < endMs &&
        new Date(pick.endsAt).getTime() > startMs,
    )
  ) {
    return "overlap";
  }
  if (dayCap) {
    const day = calendarDateKey(calendarDayOf(new Date(startMs), dayCap.zone));
    const sameDay = others.filter(
      (pick) =>
        calendarDateKey(calendarDayOf(new Date(pick.startsAt), dayCap.zone)) ===
        day,
    ).length;
    if (sameDay >= dayCap.perDay) return "dayFull";
  }
  return null;
}

function addCalendarDays(day: Date, count: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + count, 12);
}

/** The calendar days one page of the list shows, from the `zone` day holding `fromMs`. */
export function dayListDates(fromMs: number, zone: string): Date[] {
  const first = calendarDayOf(new Date(fromMs), zone);
  return Array.from({ length: DAY_LIST_DAYS }, (_, i) =>
    addCalendarDays(first, i),
  );
}

/** The instants one page's read covers: its first day's first instant to its last day's last. */
export function dayListBounds(
  fromMs: number,
  zone: string,
): { start: Date; end: Date } {
  const dates = dayListDates(fromMs, zone);
  return dayRangeBounds(dates[0], dates[dates.length - 1], zone);
}

/**
 * Where the list opens: the latest of now, the allowed window's start and the
 * focused session, pulled back to the window's end (never before now).
 */
export function dayListAnchor(
  nowMs: number,
  allowedStartMs?: number,
  allowedEndMs?: number,
  focusMs?: number,
): number {
  const latest = Math.max(nowMs, allowedStartMs ?? nowMs, focusMs ?? nowMs);
  return allowedEndMs === undefined
    ? latest
    : Math.max(nowMs, Math.min(latest, allowedEndMs));
}

/** The first instant of the `zone` day `days` after the one holding `fromMs`. */
export function dayListPageStart(
  fromMs: number,
  zone: string,
  days: number,
): number {
  const day = addCalendarDays(calendarDayOf(new Date(fromMs), zone), days);
  return dayRangeBounds(day, day, zone).start.getTime();
}

/** Start instants (ms) of every atom that is free to book. */
export function freeAtomStarts(
  data: Readonly<Record<string, readonly DayListAtom[]>>,
): Set<number> {
  const free = new Set<number>();
  for (const atoms of Object.values(data)) {
    for (const atom of atoms) {
      if (
        (atom.bookingStatus ?? "available") === "available" &&
        atom.tooSoon !== true &&
        atom.limitReached !== true
      ) {
        free.add(new Date(atom.startsAt).getTime());
      }
    }
  }
  return free;
}

/** Whether a session starting at `startMs` is offered under `rules`. */
export function isStartOffered(
  startMs: number,
  free: ReadonlySet<number>,
  rules: DayListRules,
): boolean {
  const atoms = Math.max(1, Math.round(rules.sessionMinutes / 30));
  const endMs = startMs + atoms * ATOM_MS;
  const notice = Math.max(
    MINIMUM_BOOKING_LEAD_TIME_MS,
    (rules.minLeadHours ?? 0) * 60 * 60 * 1000,
  );
  if (startMs < rules.nowMs + notice) return false;
  if (rules.allowedStart && startMs < rules.allowedStart.getTime()) {
    return false;
  }
  if (rules.allowedEnd && endMs > rules.allowedEnd.getTime()) return false;
  for (let k = 0; k < atoms; k++) {
    if (!free.has(startMs + k * ATOM_MS)) return false;
  }
  return true;
}

function sessionEnd(startMs: number, sessionMinutes: number): Date {
  return new Date(
    startMs + Math.max(1, Math.round(sessionMinutes / 30)) * ATOM_MS,
  );
}

/** "9:30 am – 10:30 am". */
export function timeRangeLabel(pick: DayListPick, zone: string): string {
  return `${formatClockTime(new Date(pick.startsAt), { zone })} – ${formatClockTime(new Date(pick.endsAt), { zone })}`;
}

/** "Thu 24 Sep, 9:30 am – 10:30 am". */
export function pickLabel(pick: DayListPick, zone: string): string {
  return `${formatDayLabel(new Date(pick.startsAt), { zone })}, ${timeRangeLabel(pick, zone)}`;
}

/** One page of days from the day holding `fromMs`, with the starts each offers, in time order. */
export function buildDayList(
  data: Readonly<Record<string, readonly DayListAtom[]>>,
  rules: DayListRules,
  fromMs: number,
): DayListDay[] {
  const free = freeAtomStarts(data);
  return dayListDates(fromMs, rules.zone).map((date) => {
    const key = calendarDateKey(date);
    const startsMs = [
      ...new Set(
        (data[key] ?? []).map((atom) => new Date(atom.startsAt).getTime()),
      ),
    ]
      .filter((startMs) => isStartOffered(startMs, free, rules))
      .sort((a, b) => a - b);
    const noon = new Date(
      dayRangeBounds(date, date, rules.zone).start.getTime() + 12 * 3_600_000,
    );
    return {
      key,
      weekday: formatWeekdayShort(noon, { zone: rules.zone }),
      dayOfMonth: formatDayOfMonth(noon, { zone: rules.zone }),
      label: formatDayLabel(noon, { zone: rules.zone }),
      starts: startsMs.map((startMs) => {
        const pick = {
          startsAt: new Date(startMs).toISOString(),
          endsAt: sessionEnd(startMs, rules.sessionMinutes).toISOString(),
        };
        return { ...pick, label: timeRangeLabel(pick, rules.zone) };
      }),
    };
  });
}

/**
 * Picks inside the read's range that the latest answer no longer offers.
 * A pick outside the range is left alone: this read cannot speak for it.
 */
export function stalePicks(
  picks: readonly DayListPick[],
  data: Readonly<Record<string, readonly DayListAtom[]>>,
  rules: DayListRules,
  fromMs: number,
): string[] {
  const { start, end } = dayListBounds(fromMs, rules.zone);
  const free = freeAtomStarts(data);
  return picks
    .filter((pick) => {
      const startMs = new Date(pick.startsAt).getTime();
      if (startMs < start.getTime() || startMs > end.getTime()) return false;
      return !isStartOffered(startMs, free, rules);
    })
    .map((pick) => pick.startsAt);
}
