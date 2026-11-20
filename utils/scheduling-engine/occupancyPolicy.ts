/**
 * Centralized occupancy policy for slot conflict detection.
 *
 * FIX Bug #15: Different services used different status filters for determining
 * occupied slots, causing inconsistent booking behavior. This module defines
 * the canonical status sets that all services must use.
 *
 * Policy: A slot is "occupied" if the parent event is in an active state
 * (not yet completed, cancelled, rejected, or expired).
 */

import {
  AppointmentStatus,
  BookingSource,
  CollaboratorStatus,
  OccurrenceCompletionStatus,
  PaymentStatus,
  TrialStatus,
  Prisma,
} from "@prisma/client";
import { liveParticipant } from "@/lib/booking/participants";
import { requestHoldDeadline } from "@/lib/dashboard/money-state";

/**
 * Consultation/Subscription statuses that count as "slot occupied"
 * These are active booking states where the slot should block future availability.
 *
 * - PENDING: User submitted, awaiting consultant approval (tentative hold)
 * - APPROVED: Consultant approved (confirmed)
 * - APPROVED_PENDING_PAYMENT: Approved but payment not yet completed
 */
export const OCCUPIED_REQUEST_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.APPROVED,
  AppointmentStatus.APPROVED_PENDING_PAYMENT,
];

/** Webinar/Class statuses that count as "slot occupied": a published event stays SCHEDULED until it completes. */
export const OCCUPIED_EVENT_STATUSES = ["SCHEDULED"] as const;

/**
 * An occurrence row that still holds its time. A host-cancelled session keeps its row for make-up and
 * refund accounting but frees the time; a RESCHEDULED row is a pending reschedule's hold and still occupies.
 */
export const OCCUPYING_OCCURRENCE_WHERE = {
  deletedAt: null,
  hostCancelledAt: null,
  completionStatus: { not: OccurrenceCompletionStatus.CANCELLED },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/**
 * Build a Prisma OR clause for filtering appointments by occupied status.
 * Use this in any query that needs to determine slot occupancy/conflicts.
 *
 * @param consultantProfileId - Optional consultant profile ID to scope the query
 * @returns Prisma OR clause array for appointment filtering
 */
export function buildOccupiedAppointmentFilter(
  consultantProfileId?: string,
): Prisma.AppointmentWhereInput[] {
  const filters: Prisma.AppointmentWhereInput[] = [
    {
      consultation: {
        ...(consultantProfileId
          ? { consultationPlan: { consultantProfileId } }
          : {}),
        status: { in: OCCUPIED_REQUEST_STATUSES },
      },
    },
    {
      subscription: {
        ...(consultantProfileId
          ? { subscriptionPlan: { consultantProfileId } }
          : {}),
        status: { in: OCCUPIED_REQUEST_STATUSES },
      },
    },
    {
      webinar: {
        ...(consultantProfileId
          ? { webinarPlan: { consultantProfileId } }
          : {}),
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
      },
    },
    {
      class: {
        ...(consultantProfileId ? { classPlan: { consultantProfileId } } : {}),
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
      },
    },
  ];

  // Add trial session filter.
  //
  // AWAITING_PAYMENT occupies too: a paid trial's slot is reserved the moment
  // the consultant accepts, and stays reserved while the learner pays. Counting
  // only SCHEDULED would let someone else book the same slot during the payment
  // window, and the capture webhook would then confirm a trial into a
  // double-booked slot. The expiry job releases it by moving the trial to
  // CANCELLED, which drops out of this filter automatically.
  const OCCUPYING_TRIAL_STATUSES = [
    TrialStatus.SCHEDULED,
    TrialStatus.AWAITING_PAYMENT,
  ];

  if (consultantProfileId) {
    filters.push({
      trial: {
        is: {
          consultantProfileId,
          status: { in: OCCUPYING_TRIAL_STATUSES },
        },
      },
    });
  } else {
    filters.push({
      trial: {
        is: {
          status: { in: OCCUPYING_TRIAL_STATUSES },
        },
      },
    });
  }

  return filters;
}

/**
 * Everything that occupies one consultant's calendar.
 *
 * A consultant is busy for an active appointment when ANY of three things is
 * true: they are connected to one of its slots (they are attending it, in any
 * role), it is delivered under one of their own plans, or they hold an
 * ACCEPTED co-host seat on its webinar/class plan. All three arms are needed:
 *
 *   - Slot participation alone misses group events, whose slot rows connect
 *     registrants rather than the host.
 *   - Plan ownership alone misses every appointment where the consultant is
 *     themselves the consultee — booked with a DIFFERENT consultant, so no plan
 *     of theirs is involved.
 *   - Both alone miss the appointments where the consultant is a co-host:
 *     co-hosts are NOT slot participants (only the plan owner is denormalized
 *     onto AppointmentOccurrence, AE-2 #784), so a co-hosted webinar painted
 *     green on the co-host's own grid while the time was physically committed.
 *
 * The availability grid used to ask only the second question while the
 * allocator asked only the first, so a consultant who was a consultee elsewhere
 * saw a green cell that every allocation mode then rejected as booked. Both
 * sides now call this.
 */
export function buildConsultantOccupancyWhere(
  consultantProfileId: string | undefined,
  consultantUserId: string,
  now: Date,
): Prisma.AppointmentWhereInput {
  const reachesConsultant: Prisma.AppointmentWhereInput[] = [
    {
      // The consultant holds a seat (as consultee elsewhere) on an
      // appointment with a row that still holds its time; a lapsed seat hold
      // holds nothing.
      participants: { some: timeHoldingParticipant(now, consultantUserId) },
      occurrences: { some: OCCUPYING_OCCURRENCE_WHERE },
    },
  ];

  if (consultantProfileId) {
    reachesConsultant.push(
      { OR: buildOccupiedAppointmentFilter(consultantProfileId) },
      // Co-host commitments (webinar/class plans with an ACCEPTED seat).
      // Occupying-state scoping rides the outer AND's
      // buildOccupiedAppointmentFilter(), same as the ownership arm.
      { OR: buildCohostCommitmentFilter(consultantProfileId) },
    );
  }

  return {
    AND: [
      { OR: buildOccupiedAppointmentFilter() },
      { OR: reachesConsultant },
      { NOT: buildDeadHoldFilter(now) },
    ],
  };
}

/**
 * Webinar/class appointments where this consultant holds an ACCEPTED co-host
 * seat. Mirrors the collaborator arms of `commitmentClauses`
 * (`lib/collaborators/availability.ts`) without importing it — that module
 * owns a Prisma client instance, which must not leak into this shared filter
 * builder. Keep the two in sync: both mean "ACCEPTED on a webinar/class plan".
 */
export function buildCohostCommitmentFilter(
  consultantProfileId: string,
): Prisma.AppointmentWhereInput[] {
  const acceptedSeat = {
    some: {
      consultantProfileId,
      status: CollaboratorStatus.ACCEPTED,
    },
  };
  return [
    { webinar: { webinarPlan: { collaborators: acceptedSeat } } },
    { class: { classPlan: { collaborators: acceptedSeat } } },
  ];
}

/**
 * The two things that make a booking "being moved", as counts the JS twin can
 * read off one appointment row. The same clauses as `BEING_MOVED`
 * (`lib/data/needs-you.ts`), restated because that module loads the Prisma
 * client; hold-expiry-predicate.test.ts asserts they are equal.
 */
export const BEING_MOVED_COUNTS = {
  select: {
    rescheduleRequests: { where: { status: "PENDING_REVIEW" } },
    occurrences: {
      where: {
        isTentative: true,
        completionStatus: "RESCHEDULED",
        deletedAt: null,
      },
    },
  },
} satisfies Prisma.AppointmentCountOutputTypeDefaultArgs;

/** Everything isOccupiedByLiveAppointment reads off an appointment row. */
export const LIVE_OCCUPANCY_READ = {
  consultation: {
    select: { status: true, bookingSource: true, requestedAt: true },
  },
  subscription: {
    select: { status: true, bookingSource: true, requestedAt: true },
  },
  payment: { select: { expiresAt: true, paymentStatus: true } },
  _count: BEING_MOVED_COUNTS,
} satisfies Prisma.AppointmentSelect;

/**
 * An unanswered request asked for before this instant has outlived its hold
 * window. The request caps stop counting it at the same instant
 * (`holdingSince`), from the same window.
 */
export function requestHoldCutoff(
  kind: "CONSULTATION" | "SUBSCRIPTION",
  now: Date,
): Date {
  const releasesAt = requestHoldDeadline(kind, now) ?? now;
  return new Date(2 * now.getTime() - releasesAt.getTime());
}

/**
 * The SQL twin of isOccupiedByLiveAppointment, for callers that filter in the
 * query. Subtracts the dead holds from the occupancy filter: an
 * APPROVED_PENDING_PAYMENT or DIRECT_CHECKOUT PENDING request whose every
 * payment is EXPIRED, FAILED or past its window, and an unanswered request
 * past its hold window. A booking being moved keeps its time: a reschedule
 * puts the parent back to PENDING while its released sessions still need
 * theirs. hold-expiry-predicate.test.ts asserts the twins agree.
 *
 * Prisma subtlety: `every` is vacuously true on an appointment with no
 * payments, so `some: {}` is required alongside it — that is the SQL form of
 * the `payments.length > 0` guard in the JS predicate.
 */
export function buildDeadHoldFilter(now: Date): Prisma.AppointmentWhereInput {
  const allPaymentsDead: Prisma.AppointmentWhereInput = {
    payment: {
      some: {},
      every: {
        OR: [
          { paymentStatus: PaymentStatus.EXPIRED },
          { paymentStatus: PaymentStatus.FAILED },
          // Clock-dead only while still PENDING: a SUCCEEDED row keeps its
          // expiresAt and must never free the slot it paid for.
          { paymentStatus: PaymentStatus.PENDING, expiresAt: { lt: now } },
        ],
      },
    },
  };
  const unanswered = (kind: "CONSULTATION" | "SUBSCRIPTION") => ({
    status: AppointmentStatus.PENDING,
    bookingSource: BookingSource.REQUEST_SUBMITTED,
    requestedAt: { lt: requestHoldCutoff(kind, now) },
  });
  const notBeingMoved: Prisma.AppointmentWhereInput = {
    NOT: {
      OR: [
        {
          rescheduleRequests: {
            some: BEING_MOVED_COUNTS.select.rescheduleRequests.where,
          },
        },
        {
          occurrences: { some: BEING_MOVED_COUNTS.select.occurrences.where },
        },
      ],
    },
  };
  return {
    OR: [
      {
        consultation: { status: AppointmentStatus.APPROVED_PENDING_PAYMENT },
        ...allPaymentsDead,
      },
      {
        subscription: { status: AppointmentStatus.APPROVED_PENDING_PAYMENT },
        ...allPaymentsDead,
      },
      {
        consultation: {
          status: AppointmentStatus.PENDING,
          bookingSource: BookingSource.DIRECT_CHECKOUT,
        },
        ...allPaymentsDead,
      },
      {
        subscription: {
          status: AppointmentStatus.PENDING,
          bookingSource: BookingSource.DIRECT_CHECKOUT,
        },
        ...allPaymentsDead,
      },
      { consultation: unanswered("CONSULTATION"), ...notBeingMoved },
      { subscription: unanswered("SUBSCRIPTION"), ...notBeingMoved },
    ],
  };
}

/**
 * The seat twin of buildDeadHoldFilter: a HELD seat whose own payment has
 * lapsed (EXPIRED, FAILED, or PENDING past its window) no longer occupies the
 * event's capacity or the buyer's calendar, even before a sweep releases it.
 */
export function buildDeadSeatFilter(
  now: Date,
): Prisma.AppointmentParticipantWhereInput {
  return {
    status: "HELD",
    payment: {
      is: {
        OR: [
          { paymentStatus: PaymentStatus.EXPIRED },
          { paymentStatus: PaymentStatus.FAILED },
          { paymentStatus: PaymentStatus.PENDING, expiresAt: { lt: now } },
        ],
      },
    },
  };
}

/**
 * A participant row that holds its user's time right now: the host's row or a
 * learner seat, live by status, and not a HELD seat whose own payment has
 * lapsed. A CONFIRMED or attended seat always holds, whatever its old payment
 * deadline said. A staff row never holds time: a collaborator is busy through
 * the plan's team (`buildCohostCommitmentFilter`).
 */
export function timeHoldingParticipant(
  now: Date,
  userId?: string,
): Prisma.AppointmentParticipantWhereInput {
  return {
    ...liveParticipant(userId),
    role: { not: "COLLABORATOR" },
    NOT: buildDeadSeatFilter(now),
  };
}

/** A consultee seat that holds a place on a group event right now. */
export function seatHoldingParticipant(
  now: Date,
): Prisma.AppointmentParticipantWhereInput {
  return {
    ...liveParticipant(),
    role: "CONSULTEE",
    NOT: buildDeadSeatFilter(now),
  };
}
