/**
 * The mobile day list's model: which session starts each of the next days
 * offers, read from the same grid answer the desktop heat map paints and
 * judged by the same atom resolver (`describeAtom`).
 *
 * A start is offered only when every 30-minute atom the session covers is
 * one the week grid would let a click take: free, or part of a session of
 * this booking that is being moved. Days are calendar dates of the display
 * zone; a start belongs to the day its first atom is keyed under.
 */
import {
  atomIsFree,
  atomIsPlaceable,
  describeAtom,
  selectionConflicts,
  type AtomContext,
  type JustTakenReason,
  type OverlapDetail,
  type ServerCell,
} from "@/lib/scheduling/week-grid-model";
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
  beyondHorizon?: boolean;
  outsideCoHostHours?: boolean;
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
  /** No start is offered, and one would be if the plan's limit were not used up. */
  limitReached: boolean;
  /** No start is offered, and the day has times later than bookings open. */
  beyondHorizon: boolean;
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
  /** The lead time the server applied to the answer; re-applied between polls. */
  leadMs?: number | null;
  /** The sessions a reschedule is moving: a new time may overlap their own. */
  movingSessions?: readonly DayListPick[];
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

const NO_STARTS: ReadonlySet<number> = new Set();
const NO_OVERLAPS: OverlapDetail[] = [];

function atomCount(sessionMinutes: number): number {
  return Math.max(1, Math.round(sessionMinutes / 30));
}

/** The week grid's atom context for one answer, so both surfaces judge an atom alike. */
function dayListContext(
  data: Readonly<Record<string, readonly DayListAtom[]>>,
  rules: DayListRules,
): AtomContext {
  const serverCells = new Map<number, ServerCell>();
  for (const atoms of Object.values(data)) {
    for (const atom of atoms) {
      const startMs = new Date(atom.startsAt).getTime();
      serverCells.set(startMs, {
        startMs,
        endMs: startMs + ATOM_MS,
        bookingStatus: atom.bookingStatus ?? "available",
        tooSoon: atom.tooSoon === true,
        limitReached: atom.limitReached === true,
        beyondHorizon: atom.beyondHorizon === true,
        outsideCoHostHours: atom.outsideCoHostHours === true,
        overlappingAppointments: NO_OVERLAPS,
      });
    }
  }
  const movingStarts = new Set<number>();
  for (const session of rules.movingSessions ?? []) {
    const endMs = new Date(session.endsAt).getTime();
    for (
      let atom =
        Math.floor(new Date(session.startsAt).getTime() / ATOM_MS) * ATOM_MS;
      atom < endMs;
      atom += ATOM_MS
    ) {
      movingStarts.add(atom);
    }
  }
  return {
    serverCells,
    eventStarts: movingStarts,
    tentativeStarts: NO_STARTS,
    selectedStarts: NO_STARTS,
    justTakenStarts: NO_STARTS,
    requestedStarts: NO_STARTS,
    nowMs: rules.nowMs,
    allowedStartMs: rules.allowedStart?.getTime(),
    allowedEndMs: rules.allowedEnd?.getTime(),
    leadMs: rules.leadMs,
  };
}

/**
 * Whether a session starting at `startMs` is offered: "limit" when only the
 * plan's used-up limit keeps it back. A start inside the lead time is never
 * offered, even on the moving session's own time.
 */
function startVerdict(
  startMs: number,
  ctx: AtomContext,
  sessionMinutes: number,
): "offered" | "limit" | "no" {
  let limited = false;
  for (let k = 0; k < atomCount(sessionMinutes); k++) {
    const atomStart = startMs + k * ATOM_MS;
    const described = describeAtom(atomStart, atomStart + ATOM_MS, ctx);
    if (k === 0 && described.isTooSoon) return "no";
    // The booking horizon binds the session's start; the atoms after it only
    // have to be free, as the booking doors judge it.
    const atom = k === 0 ? described : { ...described, isBeyondHorizon: false };
    if (atomIsPlaceable(atom)) continue;
    if (!atomIsFree({ ...atom, isLimitReached: false })) return "no";
    limited = true;
  }
  return limited ? "limit" : "offered";
}

function sessionEnd(startMs: number, sessionMinutes: number): Date {
  return new Date(startMs + atomCount(sessionMinutes) * ATOM_MS);
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
  const ctx = dayListContext(data, rules);
  return dayListDates(fromMs, rules.zone).map((date) => {
    const key = calendarDateKey(date);
    const verdicts = [
      ...new Set(
        (data[key] ?? []).map((atom) => new Date(atom.startsAt).getTime()),
      ),
    ].map(
      (startMs) =>
        [startMs, startVerdict(startMs, ctx, rules.sessionMinutes)] as const,
    );
    const startsMs = verdicts
      .filter(([, verdict]) => verdict === "offered")
      .map(([startMs]) => startMs)
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
      limitReached:
        startsMs.length === 0 &&
        verdicts.some(([, verdict]) => verdict === "limit"),
      beyondHorizon:
        startsMs.length === 0 &&
        (data[key] ?? []).some((atom) => atom.beyondHorizon === true),
    };
  });
}

/**
 * Picks inside the read's range that the latest answer no longer offers, and
 * why: "taken" when someone else holds part of it or it is no longer
 * published, "expired" for every other rule. A pick outside the range is left
 * alone: this read cannot speak for it.
 */
export function stalePicks(
  picks: readonly DayListPick[],
  data: Readonly<Record<string, readonly DayListAtom[]>>,
  rules: DayListRules,
  fromMs: number,
): Map<string, JustTakenReason> {
  const { start, end } = dayListBounds(fromMs, rules.zone);
  const window = { startMs: start.getTime(), endMs: end.getTime() };
  const ctx = dayListContext(data, rules);
  const stale = new Map<string, JustTakenReason>();
  for (const pick of picks) {
    const startMs = new Date(pick.startsAt).getTime();
    if (startMs < window.startMs || startMs >= window.endMs) continue;
    if (startVerdict(startMs, ctx, rules.sessionMinutes) === "offered") {
      continue;
    }
    const atoms = Array.from(
      { length: atomCount(rules.sessionMinutes) },
      (_, k) => startMs + k * ATOM_MS,
    );
    const reasons = [...selectionConflicts(atoms, ctx, window).values()];
    stale.set(pick.startsAt, reasons.includes("taken") ? "taken" : "expired");
  }
  return stale;
}
