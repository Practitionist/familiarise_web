/**
 * The start times a host is offered for one session (a webinar, a re-time, a
 * class make-up or a pattern row), with why each one is or isn't a good pick.
 *
 * Unlike a buyer's picker, a host may run an event outside their published
 * hours, so those starts stay pickable and are only labelled. What a host can
 * never pick is a start inside the purpose's lead, outside the allowed window,
 * or overlapping a booking the grid already shows; the server's event-time
 * rules and overlap constraint refuse those regardless.
 */

import type { AvailabilityWindowData } from "@/lib/scheduling/use-availability-window";

const ATOM_MS = 30 * 60_000;

export type SingleSessionState =
  "free" | "outsideHours" | "busy" | "tooSoon" | "outsideWindow";

export interface SingleSessionOption {
  startMs: number;
  endMs: number;
  state: SingleSessionState;
  /** Whether the option can be chosen at all. */
  selectable: boolean;
}

export const SINGLE_SESSION_STATE_LABEL: Record<SingleSessionState, string> = {
  free: "Free",
  outsideHours: "Outside your hours",
  busy: "Busy",
  tooSoon: "Too soon",
  outsideWindow: "Not allowed",
};

/** Each published half-hour atom keyed by its start, with whether it is already booked. */
export function atomIndex(
  data: AvailabilityWindowData | undefined,
): Map<number, boolean> {
  const atoms = new Map<number, boolean>();
  if (!data) return atoms;
  for (const day of Object.values(data)) {
    for (const cell of day) {
      const start = Date.parse(cell.startsAt);
      const end = Date.parse(cell.endsAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const booked = cell.bookingStatus !== "available";
      for (let t = start; t < end; t += ATOM_MS) {
        // A booked flag on any cell covering the atom wins.
        atoms.set(t, (atoms.get(t) ?? false) || booked);
      }
    }
  }
  return atoms;
}

/**
 * Every half-hour start in `[dayStartMs, dayEndMs)` that fits a session of
 * `sessionMinutes`, classified. A start whose session would run past the day
 * still counts: an evening session may end after midnight.
 */
export function singleSessionOptions(input: {
  atoms: Map<number, boolean>;
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
    let state: SingleSessionState;
    if (
      (input.allowedStartMs !== undefined && startMs < input.allowedStartMs) ||
      (input.allowedEndMs !== undefined && endMs > input.allowedEndMs)
    ) {
      state = "outsideWindow";
    } else if (startMs < input.notBeforeMs) {
      state = "tooSoon";
    } else {
      let published = true;
      let booked = false;
      for (let t = startMs; t < endMs; t += ATOM_MS) {
        const atom = input.atoms.get(t);
        if (atom === undefined) published = false;
        else if (atom) booked = true;
      }
      state = booked ? "busy" : published ? "free" : "outsideHours";
    }
    options.push({
      startMs,
      endMs,
      state,
      selectable: state === "free" || state === "outsideHours",
    });
  }
  return options;
}
