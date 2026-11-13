/**
 * The times the single-time picker offers for one session, each with a state.
 *
 * A host places an event: every half-hour start is classified, and starts
 * outside published hours stay pickable because an event may run outside
 * usual hours. A buyer books inside the expert's published hours only: the
 * free windows are exactly the ones `windowsForDay` and `isBookableWindow`
 * offer, a window the door said someone else holds is contended, and a
 * window over a booking is counted as taken. The lead and the lattice are
 * the writers' own rules (`leadMsFor`, `eventLeadMs`), never restated here.
 */

import {
  eventLeadMs,
  type EventTimePurpose,
} from "@/lib/booking/event-time-rules";
import { leadMsFor, type LeadPurpose } from "@/lib/booking/lead-time";
import {
  isBookableWindow,
  windowsForDay,
  type GridAtomInput,
} from "@/lib/scheduling/booking-windows";
import type { AvailabilityWindowData } from "@/lib/scheduling/use-availability-window";
import { calendarDateKey, dayRangeBounds } from "@/lib/time/grid-zone";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";

const ATOM_MS = 30 * 60_000;

export type SingleSessionState =
  "free" | "taken" | "contended" | "outside-hours" | "too-soon";

export interface SingleSessionOption {
  startMs: number;
  endMs: number;
  state: SingleSessionState;
  /** Whether the option can be chosen at all. */
  selectable: boolean;
}

/** How a host reads each state. */
export const SINGLE_SESSION_STATE_LABEL: Record<SingleSessionState, string> = {
  free: "Free",
  taken: "Booked",
  contended: "Taken",
  "outside-hours": "Outside your hours",
  "too-soon": "Too soon",
};

/** Which writer a pick goes to: an event time, or a booking at its own lead. */
export type SingleTimePurpose = EventTimePurpose | LeadPurpose;

const EVENT_PURPOSES: ReadonlySet<SingleTimePurpose> = new Set([
  "create",
  "makeup",
  "retime",
]);

function isEventPurpose(
  purpose: SingleTimePurpose,
): purpose is EventTimePurpose {
  return EVENT_PURPOSES.has(purpose);
}

/** The lead the writer for `purpose` enforces; `settled` matters only to a request or an allocation. */
export function singleTimeLeadMs(
  purpose: SingleTimePurpose,
  settled = true,
): number {
  return isEventPurpose(purpose)
    ? eventLeadMs(purpose)
    : leadMsFor(purpose, { settled });
}

/** Each published half-hour atom keyed by its start, with whether it is already booked. */
export function atomIndex(
  data:
    | AvailabilityWindowData
    | Readonly<Record<string, readonly GridAtomInput[]>>
    | undefined,
): Map<number, boolean> {
  const atoms = new Map<number, boolean>();
  if (!data) return atoms;
  for (const day of Object.values(data)) {
    for (const cell of day) {
      const start = Date.parse(cell.startsAt);
      const end = cell.endsAt ? Date.parse(cell.endsAt) : start + ATOM_MS;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const booked = (cell.bookingStatus ?? "available") !== "available";
      for (let t = start; t < end; t += ATOM_MS) {
        // A booked flag on any cell covering the atom wins.
        atoms.set(t, (atoms.get(t) ?? false) || booked);
      }
    }
  }
  return atoms;
}

function coverOf(
  atoms: ReadonlyMap<number, boolean>,
  startMs: number,
  endMs: number,
): { published: boolean; booked: boolean } {
  let published = true;
  let booked = false;
  for (let t = startMs; t < endMs; t += ATOM_MS) {
    const atom = atoms.get(t);
    if (atom === undefined) published = false;
    else if (atom) booked = true;
  }
  return { published, booked };
}

const withinAllowed = (
  startMs: number,
  endMs: number,
  allowedStartMs: number | undefined,
  allowedEndMs: number | undefined,
) =>
  (allowedStartMs === undefined || startMs >= allowedStartMs) &&
  (allowedEndMs === undefined || endMs <= allowedEndMs);

/**
 * Every half-hour start in `[dayStartMs, dayEndMs)` inside the allowed window,
 * classified for a host. A session may run past the day's end: an evening
 * session that ends after midnight is one session on the day it starts.
 */
export function singleSessionOptions(input: {
  atoms: ReadonlyMap<number, boolean>;
  dayStartMs: number;
  dayEndMs: number;
  sessionMinutes: number;
  notBeforeMs: number;
  allowedStartMs?: number;
  allowedEndMs?: number;
}): SingleSessionOption[] {
  const sessionMs = Math.max(ATOM_MS, input.sessionMinutes * 60_000);
  const first = Math.ceil(input.dayStartMs / ATOM_MS) * ATOM_MS;
  const options: SingleSessionOption[] = [];
  for (let startMs = first; startMs < input.dayEndMs; startMs += ATOM_MS) {
    const endMs = startMs + sessionMs;
    if (
      !withinAllowed(startMs, endMs, input.allowedStartMs, input.allowedEndMs)
    ) {
      continue;
    }
    let state: SingleSessionState;
    if (startMs < input.notBeforeMs) {
      state = "too-soon";
    } else {
      const { published, booked } = coverOf(input.atoms, startMs, endMs);
      if (booked) state = "taken";
      else state = published ? "free" : "outside-hours";
    }
    options.push({
      startMs,
      endMs,
      state,
      selectable: state === "free" || state === "outside-hours",
    });
  }
  return options;
}

/**
 * A buyer's options for one day: the bookable windows, the windows the door
 * reported held by someone else (`heldStarts`), and, for the count line, the
 * windows inside published hours that overlap a booking. Past and too-soon
 * starts are neither offered nor counted.
 */
export function buyerTimeOptions(input: {
  /** The day's grid atoms followed by the next day's, so a session may cross midnight. */
  atoms: readonly GridAtomInput[];
  dayStartMs: number;
  dayEndMs: number;
  sessionMinutes: number;
  zone: string;
  nowMs: number;
  leadMs: number;
  heldStarts?: ReadonlySet<number>;
  allowedStartMs?: number;
  allowedEndMs?: number;
}): SingleSessionOption[] {
  const sessionMs = Math.max(ATOM_MS, input.sessionMinutes * 60_000);
  const free = new Set(
    windowsForDay(
      input.atoms,
      input.sessionMinutes / 60,
      input.zone,
      input.nowMs,
      input.leadMs,
    )
      .filter(isBookableWindow)
      .map((window) => Date.parse(window.startsAt)),
  );
  const index = atomIndex({ day: input.atoms });
  const first = Math.ceil(input.dayStartMs / ATOM_MS) * ATOM_MS;
  const options: SingleSessionOption[] = [];
  for (let startMs = first; startMs < input.dayEndMs; startMs += ATOM_MS) {
    const endMs = startMs + sessionMs;
    // The writers refuse a start at or before now plus the lead.
    if (startMs <= input.nowMs + input.leadMs) continue;
    if (
      !withinAllowed(startMs, endMs, input.allowedStartMs, input.allowedEndMs)
    ) {
      continue;
    }
    let state: SingleSessionState | null = null;
    if (input.heldStarts?.has(startMs)) state = "contended";
    else if (free.has(startMs)) state = "free";
    else {
      const { published, booked } = coverOf(index, startMs, endMs);
      if (published && booked) state = "taken";
    }
    if (state !== null) {
      options.push({ startMs, endMs, state, selectable: state === "free" });
    }
  }
  return options;
}

export type PickerAudience = "buyer" | "host";

export interface DayOptionsInput {
  audience: PickerAudience;
  /** The grid answer, days keyed `yyyy-MM-dd` in `zone`. */
  data: AvailabilityWindowData | undefined;
  zone: string;
  sessionMinutes: number;
  nowMs: number;
  leadMs: number;
  heldStarts?: ReadonlySet<number>;
  allowedStartMs?: number;
  allowedEndMs?: number;
}

const nextCalendarDay = (day: Date) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 12);

/** The options of one calendar date (local noon, read in `zone`) for either audience. */
export function optionsForDay(
  day: Date,
  input: DayOptionsInput,
  hostAtoms?: ReadonlyMap<number, boolean>,
): SingleSessionOption[] {
  const { start, end } = dayRangeBounds(day, day, input.zone);
  if (input.audience === "host") {
    return singleSessionOptions({
      atoms: hostAtoms ?? atomIndex(input.data),
      dayStartMs: start.getTime(),
      dayEndMs: end.getTime(),
      sessionMinutes: input.sessionMinutes,
      notBeforeMs: input.nowMs + input.leadMs,
      allowedStartMs: input.allowedStartMs,
      allowedEndMs: input.allowedEndMs,
    }).filter((option) => option.state !== "too-soon");
  }
  return buyerTimeOptions({
    atoms: [
      ...(input.data?.[calendarDateKey(day)] ?? []),
      ...(input.data?.[calendarDateKey(nextCalendarDay(day))] ?? []),
    ],
    dayStartMs: start.getTime(),
    dayEndMs: end.getTime(),
    sessionMinutes: input.sessionMinutes,
    zone: input.zone,
    nowMs: input.nowMs,
    leadMs: input.leadMs,
    heldStarts: input.heldStarts,
    allowedStartMs: input.allowedStartMs,
    allowedEndMs: input.allowedEndMs,
  });
}

/** Whether each day (keyed `yyyy-MM-dd`) has at least one free time. */
export function monthSummary(
  days: readonly Date[],
  input: DayOptionsInput,
): Map<string, boolean> {
  const hostAtoms =
    input.audience === "host" ? atomIndex(input.data) : undefined;
  const summary = new Map<string, boolean>();
  for (const day of days) {
    summary.set(
      calendarDateKey(day),
      optionsForDay(day, input, hostAtoms).some(
        (option) => option.state === "free",
      ),
    );
  }
  return summary;
}

/** How many of a day's times are taken by a booking; past and too-soon times never count. */
export function takenTimesCount(
  options: readonly SingleSessionOption[],
): number {
  return options.filter((option) => option.state === "taken").length;
}

/** "N times already taken", or null when none are. */
export function takenTimesLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 time already taken" : `${count} times already taken`;
}

export type DayPeriod = "Morning" | "Afternoon" | "Evening";

/** Before noon, before 5 pm, or later, on the wall clock of `zone`. */
export function dayPeriodOf(startMs: number, zone: string): DayPeriod {
  const { hour } = ScheduleCalculationService.wallClock(
    new Date(startMs),
    zone,
  );
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}
