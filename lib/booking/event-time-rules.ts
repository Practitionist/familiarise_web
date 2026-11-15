/**
 * One rule set for the time a host gives a webinar, a class make-up or a
 * re-timed event. Every writer that stores such a time calls it, so the
 * editor, the re-time dialog and the make-up picker can never disagree with
 * the server about which starts are legal.
 *
 * - The start is on the UTC half-hour lattice every slot lock and the overlap
 *   constraint use (which also keeps a UTC+05:45 host on the grid).
 * - It is far enough ahead for its purpose: an hour to publish or schedule a
 *   make-up, the 24-hour reschedule notice to move a sold event.
 * - The end is the start plus whole minutes, never wall-clock hour arithmetic,
 *   so a 90-minute webinar ends 90 minutes later in every zone.
 */

import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { RESCHEDULE_LEAD_TIME_MS } from "@/lib/booking/lead-time";

export type EventTimePurpose = "create" | "makeup" | "retime";

/** How far ahead a newly published webinar or a class make-up may start. */
export const EVENT_SCHEDULE_LEAD_MS = 60 * 60_000;

export function eventLeadMs(purpose: EventTimePurpose): number {
  return purpose === "retime"
    ? RESCHEDULE_LEAD_TIME_MS
    : EVENT_SCHEDULE_LEAD_MS;
}

export interface EventTimeRefusal {
  code: "EVENT_TIME_INVALID";
  message: string;
}

const LEAD_WORDS: Record<EventTimePurpose, string> = {
  create: "at least 1 hour from now",
  makeup: "at least 1 hour from now",
  retime: "at least 24 hours from now",
};

/** True when `startsAt` is a real instant on the UTC half-hour lattice. */
export function isOnEventLattice(startsAt: Date): boolean {
  const ms = startsAt.getTime();
  return Number.isFinite(ms) && ms % SCHEDULING_INTERVAL_MS === 0;
}

/** Null when `startsAt` is a legal start for `purpose`, else plain copy to show. */
export function eventTimeRefusal(
  startsAt: Date,
  purpose: EventTimePurpose,
  now: Date = new Date(),
): EventTimeRefusal | null {
  const ms = startsAt.getTime();
  if (!Number.isFinite(ms)) {
    return {
      code: "EVENT_TIME_INVALID",
      message:
        "The start time could not be read. Pick the date and time again.",
    };
  }
  if (!isOnEventLattice(startsAt)) {
    return {
      code: "EVENT_TIME_INVALID",
      message: "Pick a start time on the hour or half hour.",
    };
  }
  if (ms < now.getTime() + eventLeadMs(purpose)) {
    return {
      code: "EVENT_TIME_INVALID",
      message: `Pick a start time ${LEAD_WORDS[purpose]}.`,
    };
  }
  return null;
}

/** The exclusive end of a session of `durationMinutes` that starts at `startsAt`. */
export function eventEndOf(startsAt: Date, durationMinutes: number): Date {
  return new Date(startsAt.getTime() + Math.round(durationMinutes) * 60_000);
}
