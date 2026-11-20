// How the allocator counts an event's occurrences: carried tentatives,
// live releases, confirmed intervals, and the top-up arithmetic.

import {
  EventType,
  EventConfig,
  isRecurringEventType,
  isReleasedForReschedule,
} from "@/utils/scheduling-engine/types";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import {
  intervalCountOf,
  intervalStartsOf,
  isDeadOccurrence,
} from "@/lib/appointments/occurrences";
import { TWENTY_FOUR_HOURS_IN_MS } from "@/utils/scheduling-engine/slotTimeUtils";
import {
  AllocationValidationError,
  SlotShortageError,
} from "@/utils/scheduling-engine/errors";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";

/**
 * Two definitions this file used to answer three ways, each now said once.
 *
 * `liveOccurrenceWhere` / `isDeadOccurrence` are canonical; these are their
 * narrow companions for the two concepts the allocator counts.
 */

/**
 * A tentative row the event STILL CARRIES — the unit #1012's stale-tab guard
 * counts, and the unit every client counts with (the request inbox and the
 * appointment detail both read occurrences filtered `deletedAt: null`).
 *
 * Deliberately NOT `isDeadOccurrence`: a reschedule releases a row IN PLACE as
 * `isTentative: true` + `completionStatus: RESCHEDULED`, which is exactly the
 * row the reschedule is replacing. Excluding completionStatus would drop the
 * very rows the guard exists to protect and 409 every reschedule as stale.
 * A tombstoned row is the one both sides must agree to ignore: the client never
 * sees it, so counting it only ever produced a false conflict.
 * `isReleasedForReschedule` stays the stricter predicate for the narrower
 * "released" concept (isReschedule, top-up gating, requiredSlots).
 */
export function isCarriedTentativeOccurrence(
  // Structural, and only the two fields the body reads. Typed against the
  // whole `AppointmentOccurrence` this predicate could not be passed to a
  // caller that selects a narrower occurrence shape — the in-transaction
  // re-read picks four columns, not forty.
  occurrence: { isTentative: boolean | null; deletedAt: Date | null },
): boolean {
  return !!occurrence.isTentative && !occurrence.deletedAt;
}

/** A CONFIRMED row the calendar still shows: not tentative, not dead. */
export function isLiveConfirmedOccurrence(
  occurrence: AppointmentWithSlots["occurrences"][number],
): boolean {
  return !occurrence.isTentative && !isDeadOccurrence(occurrence);
}

/**
 * #1766 — a subscription with held (confirmed, live) sessions and no
 * reschedule in flight is placing its NEXT CYCLE: additive, never a replan.
 */
export function isSubscriptionTopUp(
  eventType: EventType,
  existingConfirmedSessionCount: number,
  isReschedule: boolean,
): boolean {
  return (
    eventType === "subscription" &&
    existingConfirmedSessionCount > 0 &&
    !isReschedule
  );
}

/**
 * The session count a top-up reports against. A subscription owes
 * held + `nextBatch` (#1766, one cycle at a time); a class still owes the
 * plan's whole total (#1206).
 */
export function topUpTargetSessions(
  eventType: EventType,
  config: EventConfig,
  existingConfirmedSessionCount: number,
  slotsPerCall: number,
): number {
  if (
    eventType === "subscription" &&
    config.cycleTargetSessions !== undefined
  ) {
    return existingConfirmedSessionCount + config.cycleTargetSessions;
  }
  return Math.ceil(
    ScheduleCalculationService.calculateRequiredSlots(eventType, config) /
      slotsPerCall,
  );
}

/** "1 session" / "3 sessions". */
export function sessionsLabel(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

/**
 * The count rule for a hand-picked batch of a class or a plan, whatever the
 * batch is: fewer sessions than it owes needs `allowPartial`, and more is
 * refused, except on a class top-up, the one way a host adds sessions beyond
 * the plan's total. Returns the whole sessions picked.
 */
export function assertPickedSessionCount(args: {
  /** What owes the sessions, as the refusal names it: "This cycle", "This class". */
  subject: string;
  pickedAtoms: number;
  owedSessions: number;
  slotsPerCall: number;
  allowPartial: boolean;
  bonusAllowed: boolean;
}): number {
  const owedAtoms = args.owedSessions * args.slotsPerCall;
  const pickedSessions = Math.floor(args.pickedAtoms / args.slotsPerCall);
  if (args.pickedAtoms > owedAtoms && !args.bonusAllowed) {
    throw new AllocationValidationError(
      `${args.subject} takes ${sessionsLabel(args.owedSessions)}. Pick no more than that.`,
      "VALIDATION_ERROR",
      { atoms: args.pickedAtoms, requiredAtoms: owedAtoms },
    );
  }
  if (args.pickedAtoms < owedAtoms && !args.allowPartial) {
    throw new SlotShortageError(
      `${args.subject} takes ${sessionsLabel(args.owedSessions)}; you picked ${sessionsLabel(pickedSessions)}.`,
      pickedSessions,
      args.owedSessions,
    );
  }
  return pickedSessions;
}

/**
 * The slots this allocation is replacing — the ones a reschedule released.
 *
 * These are the identity of the reschedule, and the only safe key for finding
 * what the initiator asked for. `RescheduleRequest.appointmentId` is NOT: the
 * consultee's reschedule URL resolves to the booking's next actionable
 * session (map-consultee's nextActionableChild) while the picker deliberately
 * offers every session of the program, so on a multi-session booking the row
 * is written against one appointment and the released slots land on another.
 * Keying on the appointment made the preference apply only when the released
 * session happened to be the next one — silent, and right often enough to
 * look flaky rather than broken.
 *
 * RESCHEDULED rather than merely tentative: every pending request carries
 * tentative slots (request-for-approval and unpaid checkout both create them
 * that way), and those were never released by anybody.
 */
/**
 * #1554 — confirmed coverage in 30-minute intervals. One row is one whole
 * call, so the guards that compare against calculateRequiredSlots (which
 * counts intervals) must not count rows.
 */
export function confirmedIntervalsOf(
  appointments: AppointmentWithSlots[],
  also: (slot: AppointmentWithSlots["occurrences"][number]) => boolean = () =>
    true,
): number {
  return appointments.reduce(
    (count, appointment) =>
      count +
      appointment.occurrences
        .filter(
          (slot) => !slot.isTentative && !isDeadOccurrence(slot) && also(slot),
        )
        .reduce((n, slot) => n + intervalCountOf(slot), 0),
    0,
  );
}

export function resolveAllocationModeAndPastSlots(
  eventType: EventType,
  existingAppointments: AppointmentWithSlots[],
  existingNonTentativeSlotCount: number,
  isReschedule: boolean,
  topUp: boolean,
): {
  existingConfirmedSessionCount: number;
  isTopUp: boolean;
  pastConfirmedSlotCount: number;
  isInProgressReallocation: boolean;
} {
  if (topUp === true) {
    if (!isRecurringEventType(eventType)) {
      throw new AllocationValidationError(
        "topUp applies to subscriptions and classes only; a single-session event has nothing to top up.",
      );
    }
    if (isReschedule) {
      throw new AllocationValidationError(
        "topUp cannot run while the event has tentative sessions; finish or clear the pending reallocation first.",
      );
    }
    if (existingNonTentativeSlotCount === 0) {
      throw new AllocationValidationError(
        "topUp needs at least one confirmed session to preserve; run an ordinary allocation instead.",
      );
    }
  }

  const existingConfirmedSessionCount = existingAppointments
    .flatMap((a) => a.occurrences)
    .filter((row) => isLiveConfirmedOccurrence(row)).length;
  const isTopUp =
    !isReschedule &&
    (topUp === true ||
      isSubscriptionTopUp(
        eventType,
        existingConfirmedSessionCount,
        isReschedule,
      ));

  const now = new Date();
  const imminentCutoff = new Date(now.getTime() + TWENTY_FOUR_HOURS_IN_MS);
  const hasPastConfirmedSlots =
    !isReschedule &&
    !isTopUp &&
    confirmedIntervalsOf(
      existingAppointments,
      (slot) => new Date(slot.endsAt) <= now,
    ) > 0;
  const pastConfirmedSlotCount = hasPastConfirmedSlots
    ? confirmedIntervalsOf(
        existingAppointments,
        (slot) =>
          new Date(slot.endsAt) <= now ||
          new Date(slot.startsAt) < imminentCutoff,
      )
    : 0;
  const isInProgressReallocation =
    !isReschedule &&
    !isTopUp &&
    pastConfirmedSlotCount > 0 &&
    isRecurringEventType(eventType);

  return {
    existingConfirmedSessionCount,
    isTopUp,
    pastConfirmedSlotCount,
    isInProgressReallocation,
  };
}

/**
 * Tentative ROWS the event still carries, the unit #1012's stale-tab
 * precondition compares and the unit the client counts with. One definition
 * (`isCarriedTentativeOccurrence`) for the pre-txn read, the in-txn re-read and
 * both mode entry points that used to inline the same filter.
 */
export function tentativeSlotCountOf(
  appointments: AppointmentWithSlots[],
): number {
  return appointments.reduce(
    (count, appointment) =>
      count +
      appointment.occurrences.filter((row) => isCarriedTentativeOccurrence(row))
        .length,
    0,
  );
}

/**
 * Live reschedule releases awaiting replacement — the canonical
 * `isReleasedForReschedule` predicate (tentative + RESCHEDULED + live).
 * Bare `isTentative` over-counts: every fresh request already carries
 * tentative holds (request-for-approval and unpaid checkout create them),
 * plus stale duplicate/tombstoned rows. Counting those demanded e.g. 12
 * slots for a 4-session plan and rejected the correct 8 with
 * "replacing 6 session(s)".
 */
export function releasedSessionCountOf(
  appointments: AppointmentWithSlots[],
): number {
  return appointments.reduce(
    (count, appointment) =>
      count + appointment.occurrences.filter(isReleasedForReschedule).length,
    0,
  );
}

export function releasedOccurrenceIdsOf(
  appointments: AppointmentWithSlots[],
): string[] {
  return appointments.flatMap((appointment) =>
    appointment.occurrences
      .filter(isReleasedForReschedule)
      .map((slot) => slot.id),
  );
}

/** The interval starts the event's live sessions hold now; a released or dead row holds none. */
export function heldIntervalStartsOf(
  appointments: AppointmentWithSlots[],
): Date[] {
  return appointments.flatMap((appointment) =>
    appointment.occurrences
      .filter(
        (o) =>
          !o.deletedAt &&
          (o.completionStatus === "SCHEDULED" ||
            o.completionStatus === "UNVERIFIED"),
      )
      .flatMap((o) => intervalStartsOf(o)),
  );
}

/**
 * A request row that holds no time and asks for none: tombstoned, or
 * cancelled. Requested mode neither re-validates nor counts it.
 */
export function isVoidRequestRow(occurrence: {
  deletedAt?: Date | string | null;
  completionStatus?: string | null;
}): boolean {
  return !!occurrence.deletedAt || occurrence.completionStatus === "CANCELLED";
}
