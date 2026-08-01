import type { SlotPickerSubject } from "@/components/scheduling/slot-picker-policy";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

/**
 * Where the slot picker should already be looking when it opens (#1073).
 *
 * One resolver, not four: the surfaces differ only in which sessions their
 * subject carries. Reschedule carries the live sessions of the booking being
 * moved, Manage Timings the whole program, Allocate the request's requested
 * times, and an offering that has never been scheduled carries none at all —
 * so the same ordering answers all of them, and no surface can grow its own
 * private idea of "the thing you clicked".
 *
 * The result is an INSTANT plus how much of it means anything. Turning that
 * into a row and a week is `focusGridPosition`, which needs the timezone the
 * grid is drawn in.
 */

export interface SlotPickerFocus {
  /** The instant to open on. */
  at: Date;
  /**
   * "session" — `at` is a real session time, so its row is the row to show.
   * "period" — `at` is only a bound of the scheduling window, so its time of
   * day means nothing and the grid should anchor on first availability.
   */
  precision: "session" | "period";
}

/** Rows left visible ABOVE the target, so it reads as "in view" not "clipped". */
export const FOCUS_LEAD_ROWS = 2;

/** Sessions in these states are gone; focusing one would point at nothing. */
const DEAD_STATUSES = new Set(["CANCELLED", "RESCHEDULED"]);

interface DatedSlot {
  at: Date;
  isTentative: boolean;
}

function liveSlotsInOrder(
  subject: Pick<SlotPickerSubject, "slots">,
): DatedSlot[] {
  return (subject.slots ?? [])
    .filter((slot) => !DEAD_STATUSES.has(slot.completionStatus ?? ""))
    .map((slot) => ({
      at: new Date(slot.startsAt),
      isTentative: Boolean(slot.isTentative),
    }))
    .filter((entry) => Number.isFinite(entry.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * The window bound worth pointing at when nothing is scheduled.
 *
 * Never a date already gone: the picker clamps selection to the same bounds,
 * so opening on a week where nothing can be chosen is a dead end.
 */
function periodAnchor(now: Date, start?: Date, end?: Date): Date {
  // A window that has already closed still gets pointed at — its last day
  // explains the empty grid, where this week would not.
  if (end && now.getTime() > end.getTime()) return end;
  if (start && start.getTime() > now.getTime()) return start;
  return now;
}

/**
 * The session the picker should open on.
 *
 * A released session outranks everything because it is the one AWAITING a
 * time: on a partly-placed program the job is filling the gaps, not admiring
 * what is already booked. Failing that, the next session that has not
 * happened is what a consultant means by "this booking", and on a finished
 * one the last session is the only thing left to point at.
 */
export function resolveFocusTarget(
  subject: Pick<SlotPickerSubject, "slots" | "allowedStart" | "allowedEnd">,
  now: Date = new Date(),
): SlotPickerFocus {
  const slots = liveSlotsInOrder(subject);

  const awaitingATime = slots.find((slot) => slot.isTentative);
  if (awaitingATime) return { at: awaitingATime.at, precision: "session" };

  const upcoming = slots.find((slot) => slot.at.getTime() >= now.getTime());
  if (upcoming) return { at: upcoming.at, precision: "session" };

  const mostRecentPast = slots[slots.length - 1];
  if (mostRecentPast) return { at: mostRecentPast.at, precision: "session" };

  return {
    at: periodAnchor(now, subject.allowedStart, subject.allowedEnd),
    precision: "period",
  };
}

export interface FocusGridPosition {
  /** Calendar date in the grid's timezone; the week containing it is shown. */
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Index into the 48 half-hour rows the week grid renders. */
  rowIndex: number;
}

/**
 * The instant, as a place on the grid.
 *
 * `timeZone` must be the one the COLUMNS were drawn in. Reading the row off a
 * different zone than the cells were built in puts focus out by the UTC
 * offset — the same class of defect as the `datetime-local` bug in #1064.
 */
export function focusGridPosition(
  at: Date,
  timeZone: string,
): FocusGridPosition {
  const { year, month, day, hour, minute } = SlotCalculationService.wallClock(
    at,
    timeZone,
  );
  return {
    year,
    month,
    day,
    hour,
    minute,
    rowIndex: hour * 2 + (minute >= 30 ? 1 : 0),
  };
}

/**
 * The consultant's earliest published time of day, as a row.
 *
 * A better vertical anchor than 00:00 when the target instant is only a
 * window bound: their working day is where the grid has anything to offer.
 * Returns null when nothing is published, leaving the caller its own fallback.
 */
export function earliestAvailabilityRow(
  slots: readonly { startTime: Date }[],
  timeZone: string,
): number | null {
  let earliest: number | null = null;
  for (const slot of slots) {
    const { rowIndex } = focusGridPosition(slot.startTime, timeZone);
    if (earliest === null || rowIndex < earliest) earliest = rowIndex;
  }
  return earliest;
}

/**
 * The timezone the week grid is DRAWN in.
 *
 * Cells are built with `setHours` on a local Date and the footer prints this
 * same zone, so this — not the event's `schedulingTimezone` — is the zone the
 * columns exist in. Using the scheduling zone to pick the row would land the
 * focus off by the difference between the two whenever they disagree (#1073).
 */
export function gridTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
