import type { TimePickerSubject } from "@/components/scheduling/time-picker-policy";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";

/**
 * Where the time picker should already be looking when it opens.
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

export interface TimePickerFocus {
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
  subject: Pick<TimePickerSubject, "slots">,
): DatedSlot[] {
  return (
    (subject.slots ?? [])
      .filter((slot) => !DEAD_STATUSES.has(slot.completionStatus ?? ""))
      // Tombstones: every surface feeding this reads a relation that keeps them.
      .filter((slot) => !slot.deletedAt)
      .map((slot) => ({
        at: new Date(slot.startsAt),
        isTentative: Boolean(slot.isTentative),
      }))
      .filter((entry) => Number.isFinite(entry.at.getTime()))
      .sort((a, b) => a.at.getTime() - b.at.getTime())
  );
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
  const anchor = start && start.getTime() > now.getTime() ? start : now;
  // A start later than the end is bad data rather than a real window, but
  // honouring it would land the picker outside the bound it clamps to.
  if (end && anchor.getTime() > end.getTime()) return end;
  return anchor;
}

/**
 * The session the picker should open on.
 *
 * A released session outranks everything because it is the one AWAITING a
 * time: on a partly-placed program the job is filling the gaps, not admiring
 * what is already booked. Failing that, the next session that has not
 * happened is what a consultant means by "this booking".
 *
 * The most recent past session is the last resort, and only once the window
 * has closed. A program whose placed sessions have all run but whose period
 * still has months left has sessions LEFT to place, and they can only go in
 * the future — opening on a dead week would be both the wrong answer and,
 * in allocate mode, a needlessly wide request.
 */
export function resolveFocusTarget(
  subject: Pick<TimePickerSubject, "slots" | "allowedStart" | "allowedEnd">,
  now: Date = new Date(),
): TimePickerFocus {
  const slots = liveSlotsInOrder(subject);

  // Only one that can still BE placed. A released session whose old time has
  // already passed was never re-booked, and opening on a week where every
  // cell is disabled is the dead end `periodAnchor` avoids below.
  const awaitingATime = slots.find(
    (slot) => slot.isTentative && slot.at.getTime() >= now.getTime(),
  );
  if (awaitingATime) return { at: awaitingATime.at, precision: "session" };

  const upcoming = slots.find((slot) => slot.at.getTime() >= now.getTime());
  if (upcoming) return { at: upcoming.at, precision: "session" };

  const windowStillOpen = Boolean(
    subject.allowedEnd && subject.allowedEnd.getTime() > now.getTime(),
  );
  const mostRecentPast = slots[slots.length - 1];
  if (mostRecentPast && !windowStillOpen) {
    return { at: mostRecentPast.at, precision: "session" };
  }

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
  /** Wall-clock minutes since local midnight; the grid maps it to a row. */
  minuteOfDay: number;
}

/**
 * The instant, as a place on the grid. `timeZone` must be the one the
 * columns were drawn in, or focus lands out by the offset between them.
 */
export function focusGridPosition(
  at: Date,
  timeZone: string,
): FocusGridPosition {
  const { year, month, day, hour, minute } =
    ScheduleCalculationService.wallClock(at, timeZone);
  return { year, month, day, hour, minute, minuteOfDay: hour * 60 + minute };
}

/**
 * The consultant's earliest published time of day, as minutes since local
 * midnight — a better vertical anchor than midnight when the target is only
 * a window bound. Null when nothing is published.
 */
export function earliestAvailabilityMinute(
  slots: readonly { startTime: Date }[],
  timeZone: string,
): number | null {
  let earliest: number | null = null;
  for (const slot of slots) {
    const { minuteOfDay } = focusGridPosition(slot.startTime, timeZone);
    if (earliest === null || minuteOfDay < earliest) earliest = minuteOfDay;
  }
  return earliest;
}

/**
 * The time of day the target sits at: a session answers for itself, a window
 * bound defers to the earliest published hour.
 */
export function focusTargetMinute(
  focus: TimePickerFocus,
  availableSlots: readonly { startTime: Date }[],
  timeZone: string,
): number {
  const own = focusGridPosition(focus.at, timeZone).minuteOfDay;
  if (focus.precision !== "period") return own;
  return earliestAvailabilityMinute(availableSlots, timeZone) ?? own;
}

/** The index of the row holding `minuteOfDay`: the last row starting at or before it. */
export function rowIndexForMinute(
  rows: readonly { minuteOfDay: number }[],
  minuteOfDay: number,
): number {
  let index = 0;
  rows.forEach((row, i) => {
    if (row.minuteOfDay <= minuteOfDay) index = i;
  });
  return index;
}

/**
 * The row to bring to the top of the viewport, so the target itself sits a
 * little below it rather than clipped against the boundary.
 */
export function focusScrollRow(targetRow: number): number {
  return Math.max(0, targetRow - FOCUS_LEAD_ROWS);
}

/** The device's own zone, the fallback when the viewer has no profile zone. */
export function gridTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
