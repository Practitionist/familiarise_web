/**
 * The windows a buyer picks from: a day's 30-minute grid atoms cut into
 * session-length windows, each carrying the worst status of its atoms and the
 * server's not-bookable-yet flags. The expert page's list and day marks and
 * the trial picker all read these, so they cannot disagree.
 */
import type { DayOfWeek } from "@prisma/client";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { byCodeUnit } from "@/lib/scheduling/code-unit-order";
import type { TIntervalTiming } from "@/types/slots";
import {
  breakDownSlotsPreservingStatus,
  type BookingStatus,
} from "@/utils/scheduling-engine/intervals";

const ATOM_MS = 30 * 60 * 1000;

/** A duration window of the day's grid, with the allocation overlay and the client-side past flag. */
export type SlotWithStatus = TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
  /** Starts before now plus the checkout lead time. */
  _isPast: boolean;
  /** Starts later than a 1:1 booking may be placed. */
  beyondHorizon?: boolean;
  /** An accepted co-host's available hours do not cover it. */
  outsideCoHostHours?: boolean;
};

/** The part of a grid atom the dialog's windows need; the rest is filled in. */
export interface GridAtomInput {
  startsAt: string;
  endsAt?: string;
  isAllocated?: boolean;
  bookingStatus?: BookingStatus;
  tooSoon?: boolean;
  limitReached?: boolean;
  beyondHorizon?: boolean;
  outsideCoHostHours?: boolean;
  slotId?: string;
  dateInISO?: string;
  availabilityWindowId?: string;
  appointmentOccurrenceId?: string;
  dayOfWeek?: DayOfWeek;
  localStartTime?: string;
  localEndTime?: string;
  type?: "WEEKLY" | "CUSTOM";
}

function normalizeAtom(
  atom: GridAtomInput,
  index: number,
): TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
  beyondHorizon?: boolean;
  outsideCoHostHours?: boolean;
} {
  const startMs = new Date(atom.startsAt).getTime();
  const bookingStatus: BookingStatus = atom.bookingStatus ?? "available";
  return {
    slotId: atom.slotId ?? `atom-${index}-${startMs}`,
    dateInISO: atom.dateInISO ?? atom.startsAt,
    startsAt: atom.startsAt,
    endsAt: atom.endsAt ?? new Date(startMs + ATOM_MS).toISOString(),
    dayOfWeek: atom.dayOfWeek ?? "MONDAY",
    availabilityWindowId: atom.availabilityWindowId ?? "atom-window",
    appointmentOccurrenceId: atom.appointmentOccurrenceId ?? "",
    localStartTime: atom.localStartTime ?? "",
    localEndTime: atom.localEndTime ?? "",
    type: atom.type ?? "WEEKLY",
    isAllocated: atom.isAllocated ?? bookingStatus !== "available",
    bookingStatus,
    tooSoon: atom.tooSoon,
    limitReached: atom.limitReached,
    beyondHorizon: atom.beyondHorizon,
    outsideCoHostHours: atom.outsideCoHostHours,
  };
}

/**
 * The day's atoms cut into `durationInHours` windows, each carrying the worst
 * status of the atoms under it, the server's `tooSoon`/`limitReached` if any
 * atom has them, and `_isPast` against `nowMs` plus the checkout lead time.
 * The day marks and the list both read this, so they cannot disagree.
 */
export function windowsForDay(
  atoms: readonly GridAtomInput[],
  durationInHours: number,
  timezone: string,
  nowMs: number,
  /** The writer's lead time (`leadMsFor`): 15 min to book, 2 h for a priced request. */
  leadMs: number = MINIMUM_BOOKING_LEAD_TIME_MS,
): SlotWithStatus[] {
  if (atoms.length === 0) return [];
  const normalized = atoms.map((atom, index) => normalizeAtom(atom, index));
  const cutoff = nowMs + leadMs;
  return breakDownSlotsPreservingStatus(
    normalized,
    durationInHours,
    timezone,
  ).map((window) => {
    const start = new Date(window.startsAt).getTime();
    const end = new Date(window.endsAt).getTime();
    const under = normalized.filter((atom) => {
      const atomStart = new Date(atom.startsAt).getTime();
      return atomStart < end && new Date(atom.endsAt).getTime() > start;
    });
    return {
      ...window,
      tooSoon: under.some((atom) => atom.tooSoon === true),
      limitReached: under.some((atom) => atom.limitReached === true),
      // The writers judge the horizon by the session's start alone.
      beyondHorizon: under.some(
        (atom) =>
          atom.beyondHorizon === true &&
          new Date(atom.startsAt).getTime() === start,
      ),
      outsideCoHostHours: under.some(
        (atom) => atom.outsideCoHostHours === true,
      ),
      // The writers refuse a start at or before the cutoff.
      _isPast: start <= cutoff,
    };
  });
}

/**
 * A window that can be taken now: wholly free (a partly booked half-hour is
 * refused by every writer), not past, too soon or too far ahead, not over a
 * plan limit, and inside every co-host's available hours.
 */
export function isBookableWindow(slot: SlotWithStatus): boolean {
  return (
    !slot._isPast &&
    slot.bookingStatus === "available" &&
    slot.tooSoon !== true &&
    slot.limitReached !== true &&
    slot.beyondHorizon !== true &&
    slot.outsideCoHostHours !== true
  );
}

/**
 * The earliest window a buyer could take, across days keyed by calendar date
 * (`yyyy-MM-dd`, which sorts chronologically). Reads the same windows and the
 * same predicate as the day marks and the list, so "next available" can never
 * name a time the picker would not offer.
 */
export function nextAvailableWindow(
  days: Readonly<Record<string, readonly GridAtomInput[]>>,
  durationInHours: number,
  timezone: string,
  nowMs: number,
  leadMs: number = MINIMUM_BOOKING_LEAD_TIME_MS,
): SlotWithStatus | null {
  for (const key of Object.keys(days).sort(byCodeUnit)) {
    const windows = windowsForDay(
      days[key],
      durationInHours,
      timezone,
      nowMs,
      leadMs,
    ).filter(isBookableWindow);
    if (windows.length > 0) {
      return windows.reduce(
        (earliest, w) =>
          new Date(w.startsAt).getTime() < new Date(earliest.startsAt).getTime()
            ? w
            : earliest,
        windows[0],
      );
    }
  }
  return null;
}
