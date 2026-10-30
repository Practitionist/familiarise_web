/**
 * The windows a buyer picks from: a day's 30-minute grid atoms cut into
 * session-length windows, each carrying the worst status of its atoms and the
 * server's not-bookable-yet flags. The expert page's list and day marks and
 * the trial picker all read these, so they cannot disagree.
 */
import type { DayOfWeek } from "@prisma/client";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
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
};

/** The part of a grid atom the dialog's windows need; the rest is filled in. */
export interface GridAtomInput {
  startsAt: string;
  endsAt?: string;
  isAllocated?: boolean;
  bookingStatus?: BookingStatus;
  tooSoon?: boolean;
  limitReached?: boolean;
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
): TIntervalTiming & { isAllocated: boolean; bookingStatus: BookingStatus } {
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
): SlotWithStatus[] {
  if (atoms.length === 0) return [];
  const normalized = atoms.map((atom, index) => normalizeAtom(atom, index));
  const cutoff = nowMs + MINIMUM_BOOKING_LEAD_TIME_MS;
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
      _isPast: start < cutoff,
    };
  });
}

/** A window the buyer can take now: not past or too soon, not full, not over a plan limit. */
export function isBookableWindow(slot: SlotWithStatus): boolean {
  return (
    !slot._isPast &&
    slot.bookingStatus !== "fully-booked" &&
    slot.tooSoon !== true &&
    slot.limitReached !== true
  );
}

/** The same time window, whatever object identity the latest read gave it. */
export function sameWindow(
  a: Pick<TIntervalTiming, "startsAt" | "endsAt">,
  b: Pick<TIntervalTiming, "startsAt" | "endsAt">,
): boolean {
  return (
    new Date(a.startsAt).getTime() === new Date(b.startsAt).getTime() &&
    new Date(a.endsAt).getTime() === new Date(b.endsAt).getTime()
  );
}
