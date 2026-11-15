/**
 * Event Processing Utilities for Consultee Home Dashboard
 *
 * Provides type-safe processing of consultee events (consultations, subscriptions,
 * webinars, classes) into a unified ProcessedEvent format for display.
 */

import type {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";
import type {
  TConsulteeEventsResponse,
  TConsulteeWebinar,
  TConsulteeClass,
} from "@/types/consultee-events";
import type { MeetingAppointment, MeetingSlot } from "@/lib/meeting";
import {
  REJOIN_GRACE_MS,
  getCurrentOrNextOccurrence,
  getOccurrenceJoinState,
  liveOccurrencesOf,
} from "@/lib/appointments/occurrences";
import { deriveBucket } from "@/lib/appointments/bucket";
import type { OpenRescheduleInput } from "@/lib/appointments/booking-status";
import {
  holdOpenFrom,
  listStatusFacts,
  trialHoldFacts,
} from "@/lib/appointments/list-status-facts";
import {
  isUnpaidSeat,
  ownSeatStatusOf,
  seatLapsedOrReleased,
} from "@/lib/appointments/status";
import { payLinkHref, payablePaymentId } from "@/lib/payments/pay-link-href";
import { isOrgFundedPaymentMethod } from "@/lib/payments/org-funded";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import {
  isCancelledLikeStatus,
  isInactiveStatus,
  isPendingPaymentStatus,
  isPendingStatus,
} from "@/lib/appointments/status";
import {
  toOccurrenceVM,
  type NeedsActionReason,
} from "@/lib/appointments/view-model";

/**
 * Unified event type for display in the dashboard
 */
// Collaborator info for co-hosts display
interface ProcessedCollaborator {
  name: string;
  image?: string | null;
  role: string;
}

/** Whether the consultee holds a seat on a group event. */
export type BookingStatus = "CONFIRMED" | null;

export interface ProcessedEvent {
  id: string;
  type: "consultation" | "subscription" | "class" | "webinar" | "trial";
  title: string;
  consultantName: string;
  consultantImage?: string | null;
  /** Null while the request has no occurrence yet (awaiting approval,
   * payment or allocation); the card then reads `needsActionReason`. */
  startsAt: Date | null;
  endsAt: Date | null;
  status: string;
  /** DIRECT_CHECKOUT or REQUEST_SUBMITTED for a 1:1 or plan. */
  bookingSource?: string | null;
  /** The learner's own seat and its payment, for the shared status chip. */
  seatStatus?: string | null;
  paid?: boolean;
  payDeadline?: Date | null;
  payLapsed?: boolean;
  reschedule?: OpenRescheduleInput | null;
  slots: ProcessedEventSlot[];
  appointmentId?: string;
  /** Same derivation the Appointments page uses (lib/appointments/bucket), so
   * a slot-less request shows the same state on both surfaces. #1703 */
  needsActionReason: NeedsActionReason | null;
  /** Live pay-link while APPROVED_PENDING_PAYMENT; the "Pay now" target. */
  pendingPaymentUrl?: string | null;
  // Data needed for joining meetings
  joinableAppointment?: MeetingAppointment;
  joinableSlot?: MeetingSlot;
  // The occurrence `joinableSlot` names, so the card can ask
  // getOccurrenceJoinState for a real state (including `ended`) instead of
  // re-deriving a time window (#1554).
  joinableOccurrence?: ProcessedOccurrence | null;
  // Registration state for webinars/classes. There is no queue any more —
  // either the consultee holds a seat or the row is a plain event card.
  bookingStatus?: BookingStatus;
  // Collaborators (co-hosts) for webinars/classes
  collaborators?: ProcessedCollaborator[];
  // Org sponsorship — `Appointment.organizationId` (null = personal).
  // Drives the "Sponsored by <Org>" pill on the Home card so org-funded
  // sessions are visually distinct from personal bookings.
  organizationId?: string | null;
  /** An organization's money paid for the viewer's place (the plan host is irrelevant). */
  orgFunded: boolean;
}

/** True when one of the viewer's live payments on the booking rode an org rail. */
function paidByOrg(
  payments:
    | ReadonlyArray<{ paymentMethod?: string | null; paymentStatus?: string }>
    | null
    | undefined,
): boolean {
  return (payments ?? []).some(
    (p) =>
      p.paymentStatus !== "FAILED" &&
      p.paymentStatus !== "EXPIRED" &&
      isOrgFundedPaymentMethod(p.paymentMethod),
  );
}

/**
 * An occurrence row as this tab carries it: `MeetingSlot` (what the join
 * helper needs) plus the two fields the join helpers read. Dropping them made
 * cancelled rows read as live and left the card unable to see that the host
 * had ended the call — both silently, because they are optional on
 * `JoinableOccurrence` (#1061).
 */
export type ProcessedOccurrence = MeetingSlot & {
  completionStatus?: string | null;
  meeting?: {
    id: string;
    endedAt: Date | string | null;
    endedReason: string | null;
  } | null;
};

/**
 * Internal type for tracking slots with their raw data
 */
interface SlotWithContext {
  startsAt: Date;
  endsAt: Date;
  rawSlot: ProcessedOccurrence;
  appointmentId: string;
}

/**
 * A slot as the card's session list carries it.
 *
 * #1199 — this used to be `{ startsAt, endsAt, appointmentId }` and nothing
 * more, which is exactly the shape that cannot answer "is this one session or
 * two". The identity, the tentative flag and the completion status ride along
 * now so the month view can group on runs like every other surface does.
 */
export type ProcessedEventSlot = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  appointmentId: string;
  isTentative: boolean;
  completionStatus: string | null;
};

function toEventSlot(slot: SlotWithContext): ProcessedEventSlot {
  return {
    id: slot.rawSlot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    appointmentId: slot.appointmentId,
    isTentative: Boolean(slot.rawSlot.isTentative),
    completionStatus: slot.rawSlot.completionStatus ?? null,
  };
}

/** A picked call: the occurrence, in list-item shape. */
interface SessionPick extends SlotWithContext {
  run: ProcessedOccurrence | null;
}

/**
 * The session that is live or next up, spanning its whole run of slot rows.
 *
 * #1061 — this used to return the first slot whose `startsAt` was in the
 * FUTURE. From minute 0 of a one-hour session that is the second half-hour
 * row, so Home greyed Join out while the session was live and then, once the
 * second row's own window opened, dropped the consultee into a different room
 * from the consultant. `startsAt`/`endsAt` now describe the run, and
 * `rawSlot` is the run's anchor — the row the video room is keyed to.
 */
function findNextSlot(
  slots: SlotWithContext[],
  now: Date = new Date(),
): SessionPick | null {
  if (slots.length === 0) return null;

  const run = getCurrentOrNextOccurrence(
    slots.map((s) => ({ ...s.rawSlot, appointmentId: s.appointmentId })),
    now,
  );
  const anchor = run ? slots.find((s) => s.rawSlot.id === run.id) : undefined;
  if (run && anchor) {
    return { ...anchor, run: anchor.rawSlot };
  }

  return null;
}

/** Slot rows in the shape `findNextSlot` groups on. */
function toSlotContexts(
  slots: Array<{
    id: string;
    startsAt: Date | string;
    endsAt: Date | string | null;
    isTentative: boolean;
    appointmentId: string | null;
    completionStatus?: string | null;
    meeting?: {
      id: string;
      endedAt: Date | string | null;
      endedReason: string | null;
    } | null;
  }>,
  appointmentId: string,
): SlotWithContext[] {
  return slots.map((slot) => ({
    startsAt: new Date(slot.startsAt),
    endsAt: new Date(slot.endsAt ?? slot.startsAt),
    rawSlot: {
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      isTentative: slot.isTentative,
      appointmentId: slot.appointmentId,
      // Both are already selected by the events read
      // (lib/data/consultee-events-read.ts): the slot include is unfiltered,
      // and `meeting: { id, endedAt }` is explicit on all four types.
      completionStatus: slot.completionStatus ?? null,
      meeting: slot.meeting ?? null,
    },
    appointmentId,
  }));
}

/**
 * Why a request with no live session still belongs on Home. Reads the same
 * bucketing the Appointments page uses, so "awaiting approval", "pay now" and
 * "awaiting scheduling" (an approved row with no occurrence yet) agree across
 * the two surfaces. Null once a session exists or the row is terminal.
 */
function awaitingReason(
  status: string | null | undefined,
  slots: SlotWithContext[],
  now: Date = new Date(),
  hold?: {
    source: string | null | undefined;
    open: boolean | undefined;
    paid: boolean | undefined;
    moving: boolean;
  },
): NeedsActionReason | null {
  const { bucket, needsActionReason } = deriveBucket({
    status,
    source: hold?.source,
    holdOpen: hold?.open,
    paid: hold?.paid,
    moving: hold?.moving,
    occurrences: slots.map((slot) =>
      toOccurrenceVM({
        ...slot.rawSlot,
        isTentative: Boolean(slot.rawSlot.isTentative),
        appointmentId: slot.appointmentId,
      }),
    ),
    isUnscheduled: slots.length === 0 && !isPendingOrPayment(status),
    now,
  });
  if (bucket !== "needsAction") return null;
  return needsActionReason;
}

/** An unpaid hold whose window is known to be closed can no longer happen, so Home leaves it out. */
function lapsedHold(
  status: string | null | undefined,
  facts: { paid?: boolean },
  open: boolean | undefined,
): boolean {
  return open === false && !facts.paid && isPendingOrPayment(status);
}

function isPendingOrPayment(status: string | null | undefined): boolean {
  return isPendingStatus(status) || isPendingPaymentStatus(status);
}

/**
 * Process a consultation into a ProcessedEvent
 */
function processConsultation(
  consultation: TConsultationWithPlan,
  now: Date = new Date(),
): ProcessedEvent | null {
  const slots = consultation.appointment?.occurrences ?? [];
  const appointmentId = consultation.appointment?.id ?? "";
  const slotContexts = toSlotContexts(slots, appointmentId);
  // #1061 — the card's time range and its Join target are the whole session,
  // not the first 30-minute row of it.
  const session = findNextSlot(slotContexts, now);
  // A fresh request has no occurrence yet; it used to vanish from Home while
  // the Appointments page showed it awaiting approval (#1703).
  const holdFacts = listStatusFacts(consultation.appointment, []);
  if (
    lapsedHold(consultation.status, holdFacts, holdOpenFrom(holdFacts, now))
  ) {
    return null;
  }
  const needsActionReason = awaitingReason(
    consultation.status,
    slotContexts,
    now,
    {
      source: consultation.bookingSource,
      open: holdOpenFrom(holdFacts, now),
      paid: holdFacts.paid,
      moving: !!holdFacts.reschedule,
    },
  );
  if (!session && !needsActionReason) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "CONSULTATION",
    occurrences: slots.map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      isTentative: s.isTentative,
      appointmentId: s.appointmentId,
    })),
    consultation: {
      consultationPlan: {
        title: consultation.consultationPlan?.title,
      },
      requestedBy: {
        user: {
          name: consultation.consultationPlan?.consultantProfile?.user?.name,
        },
      },
    },
  };

  const joinableSlot: MeetingSlot | undefined = session?.rawSlot;

  return {
    id: consultation.id,
    type: "consultation",
    title: consultation.consultationPlan?.title ?? "Consultation",
    consultantName:
      consultation.consultationPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage:
      consultation.consultationPlan?.consultantProfile?.user?.image,
    startsAt: session?.startsAt ?? null,
    endsAt: session?.endsAt ?? null,
    status: consultation.status ?? "PENDING",
    bookingSource: consultation.bookingSource,
    paid: holdFacts.paid,
    payDeadline: holdFacts.payDeadline,
    payLapsed: holdFacts.payLapsed,
    reschedule: holdFacts.reschedule,
    slots: slotContexts.map(toEventSlot),
    appointmentId,
    needsActionReason,
    // #1775 P-1 — the Pay target: our pay page for an order id, else the link.
    pendingPaymentUrl: payLinkHref({
      paymentId: payablePaymentId(consultation.appointment?.payment),
      checkoutUrl: consultation.pendingPaymentUrl,
    }),
    joinableAppointment: session ? joinableAppointment : undefined,
    joinableSlot,
    joinableOccurrence: session?.run ?? null,
    organizationId: consultation.appointment?.organizationId ?? null,
    orgFunded: paidByOrg(consultation.appointment?.payment),
  };
}

/**
 * Process a subscription into a ProcessedEvent
 */
function processSubscription(
  subscription: TSubscriptionWithPlan,
  now: Date = new Date(),
): ProcessedEvent | null {
  // #1554 — one wrapper per subscription, N occurrences.
  const nextAppointment = subscription.appointment;
  const allSlots: SlotWithContext[] = nextAppointment
    ? toSlotContexts(nextAppointment.occurrences ?? [], nextAppointment.id)
    : [];

  const nextSlot = findNextSlot(allSlots, now);
  // A paid subscription awaiting allocation has a wrapper and no occurrences;
  // it used to vanish from Home (#1703).
  const planFacts = listStatusFacts(nextAppointment, []);
  if (
    lapsedHold(subscription.status, planFacts, holdOpenFrom(planFacts, now))
  ) {
    return null;
  }
  const needsActionReason = awaitingReason(subscription.status, allSlots, now, {
    source: subscription.bookingSource,
    open: holdOpenFrom(planFacts, now),
    paid: planFacts.paid,
    moving: !!planFacts.reschedule,
  });
  if (!nextSlot && !needsActionReason) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: nextAppointment?.id ?? "",
    appointmentType: "SUBSCRIPTION",
    occurrences:
      nextAppointment?.occurrences?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    subscription: {
      subscriptionPlan: {
        title: subscription.subscriptionPlan?.title,
      },
      requestedBy: {
        user: {
          name: subscription.subscriptionPlan?.consultantProfile?.user?.name,
        },
      },
    },
  };

  return {
    id: subscription.id,
    type: "subscription",
    title: subscription.subscriptionPlan?.title ?? "Subscription",
    consultantName:
      subscription.subscriptionPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage:
      subscription.subscriptionPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot?.startsAt ?? null,
    endsAt: nextSlot?.endsAt ?? null,
    status: subscription.status ?? "PENDING",
    bookingSource: subscription.bookingSource,
    paid: planFacts.paid,
    payDeadline: planFacts.payDeadline,
    payLapsed: planFacts.payLapsed,
    reschedule: planFacts.reschedule,
    slots: allSlots.map(toEventSlot),
    appointmentId: nextAppointment?.id,
    needsActionReason,
    pendingPaymentUrl: payLinkHref({
      paymentId: payablePaymentId(nextAppointment?.payment),
      checkoutUrl: subscription.pendingPaymentUrl,
    }),
    joinableAppointment: nextSlot ? joinableAppointment : undefined,
    joinableSlot: nextSlot?.rawSlot,
    joinableOccurrence: nextSlot?.run ?? null,
    organizationId: nextAppointment?.organizationId ?? null,
    orgFunded: paidByOrg(nextAppointment?.payment),
  };
}

/**
 * Process a webinar into a ProcessedEvent
 */
/** The learner's own held order on a seat, for its Pay link. */
function payablePaymentIdOf(
  appointment:
    | {
        payment?: ReadonlyArray<{
          id: string;
          paymentStatus: string;
          createdAt?: Date | string;
        }> | null;
      }
    | null
    | undefined,
): string | null {
  return payablePaymentId(appointment?.payment);
}

/**
 * The learner's own seat decides a group card: a released or lapsed seat is
 * not on Home, and a held one they have not paid is a Pay task with no Join.
 */
function seatGate(
  appointment: Parameters<typeof listStatusFacts>[0] &
    Parameters<typeof ownSeatStatusOf>[0] &
    Parameters<typeof payablePaymentIdOf>[0],
  now: Date,
) {
  const seatStatus = ownSeatStatusOf(appointment);
  const facts = listStatusFacts(appointment, []);
  const seat = { seatStatus, ...facts };
  return {
    seat,
    skip: seatLapsedOrReleased(seat, now),
    unpaid: isUnpaidSeat(seat),
    payUrl: payLinkHref({
      paymentId: payablePaymentIdOf(appointment),
      checkoutUrl: null,
    }),
  };
}

function processWebinar(
  webinar: TConsulteeWebinar,
  now: Date = new Date(),
): ProcessedEvent | null {
  // A seat the learner no longer holds belongs to the Appointments list's Cancelled tab, not Home.
  const gate = seatGate(webinar.appointment, now);
  if (gate.skip) return null;
  const allSlots: SlotWithContext[] = [];
  const appointmentId = webinar.appointment?.id ?? "";

  // Get slots from the appointment
  allSlots.push(
    ...toSlotContexts(webinar.appointment?.occurrences ?? [], appointmentId),
  );

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots, now);
  if (!nextSlot) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "WEBINAR",
    occurrences:
      webinar.appointment?.occurrences?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    webinar: {
      webinarPlan: {
        title: webinar.webinarPlan?.title,
      },
    },
  };

  // Registered = the consultee is connected to at least one session slot.
  // A host's session confirms the event, not this learner's unpaid seat.
  const bookingStatus: BookingStatus =
    !gate.unpaid && (webinar.appointment?.occurrences?.length ?? 0) > 0
      ? "CONFIRMED"
      : null;

  // Extract collaborators
  const collaborators: ProcessedCollaborator[] = (
    webinar.webinarPlan?.collaborators ?? []
  ).map((c) => ({
    name: c.consultantProfile?.user?.name ?? "Collaborator",
    image: c.consultantProfile?.user?.image,
    role: c.role,
  }));

  return {
    id: webinar.id,
    type: "webinar",
    title: webinar.webinarPlan?.title ?? "Webinar",
    consultantName:
      webinar.webinarPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: webinar.webinarPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: webinar.status ?? "APPROVED",
    slots: allSlots.map(toEventSlot),
    appointmentId,
    needsActionReason: gate.unpaid ? "PAY_NOW" : null,
    pendingPaymentUrl: gate.unpaid ? gate.payUrl : null,
    seatStatus: gate.seat.seatStatus,
    paid: gate.seat.paid,
    payDeadline: gate.seat.payDeadline,
    payLapsed: gate.seat.payLapsed,
    joinableAppointment: gate.unpaid ? undefined : joinableAppointment,
    joinableSlot: gate.unpaid ? undefined : nextSlot.rawSlot,
    joinableOccurrence: gate.unpaid ? null : nextSlot.run,
    bookingStatus,
    collaborators,
    organizationId: webinar.appointment?.organizationId ?? null,
    orgFunded: paidByOrg(webinar.appointment?.payment),
  };
}

/**
 * Process a class into a ProcessedEvent
 */
function processClass(
  classEvent: TConsulteeClass,
  now: Date = new Date(),
): ProcessedEvent | null {
  // A seat the learner no longer holds belongs to the Appointments list's Cancelled tab, not Home.
  const gate = seatGate(classEvent.appointment, now);
  if (gate.skip) return null;
  // #1554 — one wrapper per class, N occurrences.
  const nextAppointment = classEvent.appointment;
  const allSlots: SlotWithContext[] = nextAppointment
    ? toSlotContexts(nextAppointment.occurrences ?? [], nextAppointment.id)
    : [];

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots, now);
  if (!nextSlot) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: nextSlot.appointmentId,
    appointmentType: "CLASS",
    occurrences:
      nextAppointment?.occurrences?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    class: {
      classPlan: {
        title: classEvent.classPlan?.title,
      },
    },
  };

  // A host's session confirms the event, not this learner's unpaid seat.
  const bookingStatus: BookingStatus =
    !gate.unpaid && (classEvent.appointment?.occurrences?.length ?? 0) > 0
      ? "CONFIRMED"
      : null;

  // Extract collaborators
  const collaborators: ProcessedCollaborator[] = (
    classEvent.classPlan?.collaborators ?? []
  ).map((c) => ({
    name: c.consultantProfile?.user?.name ?? "Collaborator",
    image: c.consultantProfile?.user?.image,
    role: c.role,
  }));

  return {
    id: classEvent.id,
    type: "class",
    title: classEvent.classPlan?.title ?? "Class",
    consultantName:
      classEvent.classPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: classEvent.classPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: classEvent.status ?? "APPROVED",
    slots: allSlots.map(toEventSlot),
    appointmentId: nextSlot.appointmentId,
    needsActionReason: gate.unpaid ? "PAY_NOW" : null,
    pendingPaymentUrl: gate.unpaid ? gate.payUrl : null,
    seatStatus: gate.seat.seatStatus,
    paid: gate.seat.paid,
    payDeadline: gate.seat.payDeadline,
    payLapsed: gate.seat.payLapsed,
    joinableAppointment: gate.unpaid ? undefined : joinableAppointment,
    joinableSlot: gate.unpaid ? undefined : nextSlot.rawSlot,
    joinableOccurrence: gate.unpaid ? null : nextSlot.run,
    bookingStatus,
    collaborators,
    organizationId: nextAppointment?.organizationId ?? null,
    orgFunded: paidByOrg(nextAppointment?.payment),
  };
}

/**
 * Process a trial into a ProcessedEvent
 */
function processTrial(
  trial: TTrialWithPlan,
  now: Date = new Date(),
): ProcessedEvent | null {
  const slots = trial.appointment?.occurrences ?? [];
  const appointmentId = trial.appointment?.id ?? "";
  const slotContexts = toSlotContexts(slots, appointmentId);
  const session = findNextSlot(slotContexts, now);
  const hold = trialHoldFacts(trial);
  const holdOpen = holdOpenFrom(hold, now);
  if (lapsedHold(trial.status, hold, holdOpen)) return null;
  const needsActionReason = awaitingReason(trial.status, slotContexts, now, {
    source: null,
    open: holdOpen,
    paid: hold.paid,
    moving: false,
  });
  if (!session && !needsActionReason) return null;

  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "TRIAL",
    occurrences: slots.map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      isTentative: s.isTentative,
      appointmentId: s.appointmentId,
    })),
  };

  return {
    id: trial.id,
    type: "trial",
    title: trial.subscriptionPlan?.title ?? "Trial",
    consultantName:
      trial.subscriptionPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: trial.subscriptionPlan?.consultantProfile?.user?.image,
    startsAt: session?.startsAt ?? null,
    endsAt: session?.endsAt ?? null,
    status: trial.status ?? "PENDING",
    slots: slotContexts.map(toEventSlot),
    appointmentId: appointmentId || undefined,
    needsActionReason,
    ...hold,
    // Only while the window is open: the checkout refuses a lapsed trial.
    pendingPaymentUrl:
      holdOpen === false
        ? null
        : (payLinkHref({
            paymentId: payablePaymentId(
              (trial.appointment as { payment?: unknown } | null)?.payment as
                Parameters<typeof payablePaymentId>[0] | undefined,
            ),
            checkoutUrl: trial.pendingPaymentUrl,
          }) ??
          (trial.status === "AWAITING_PAYMENT"
            ? `/checkout/plans/trial/${trial.id}`
            : null)),
    joinableAppointment: session ? joinableAppointment : undefined,
    joinableSlot: session?.rawSlot,
    joinableOccurrence: session?.run ?? null,
    organizationId: trial.appointment?.organizationId ?? null,
    orgFunded: paidByOrg(trial.appointment?.payment),
  };
}

/**
 * A session is a group of contiguous slots belonging to the same appointment.
 */
export interface SessionGroup {
  /** The run's anchor row. Two runs can share an appointmentId, so keys do too. */
  id: string;
  appointmentId: string;
  startTime: Date;
  endTime: Date;
  status: "completed" | "upcoming";
}

/**
 * Group an event's slots into sessions with a time-based status.
 *
 * #1199 — this grouped by appointmentId alone, which says a booking is one
 * session no matter when its rows sit. A subscription's Tuesday 09:00 and
 * Thursday 16:00 sittings therefore merged into a single phantom session.
 * #1554 — one row is one call, so the live rows are the sessions.
 */
export function groupSlotsIntoSessions(
  slots: ProcessedEvent["slots"],
): SessionGroup[] {
  const now = new Date();
  // #1554 — one row is one call; live rows, chronological.
  return liveOccurrencesOf(slots).map((row) => ({
    id: row.id,
    appointmentId: row.appointmentId,
    startTime: row.startsAt,
    endTime: row.endsAt,
    status: (row.endsAt < now ? "completed" : "upcoming") as
      "completed" | "upcoming",
  }));
}

/**
 * Process all events from the API response into unified ProcessedEvent array
 */
export function processAllEvents(
  eventsData: TConsulteeEventsResponse,
  now: Date = new Date(),
): ProcessedEvent[] {
  const events: ProcessedEvent[] = [];

  // Process consultations
  eventsData.consultations?.forEach((c) => {
    const processed = processConsultation(c, now);
    if (processed) events.push(processed);
  });

  // Process subscriptions
  eventsData.subscriptions?.forEach((s) => {
    const processed = processSubscription(s, now);
    if (processed) events.push(processed);
  });

  // Process webinars
  eventsData.webinars?.forEach((w) => {
    const processed = processWebinar(w, now);
    if (processed) events.push(processed);
  });

  // Process classes
  eventsData.classes?.forEach((c) => {
    const processed = processClass(c, now);
    if (processed) events.push(processed);
  });

  // Process trials
  eventsData.trials?.forEach((t) => {
    const processed = processTrial(t, now);
    if (processed) events.push(processed);
  });

  return events;
}

/**
 * Live sessions of this viewer-zone month on bookings the viewer paid for
 * personally; an org-funded place belongs to the organization dashboard.
 */
export function sessionsThisMonth(
  events: ProcessedEvent[],
  zone: string,
  now: Date,
): number {
  const monthKey = formatInViewerZone(now, zone, "yyyy-MM");
  // Compared in the viewer's zone per slot, so a near-midnight session lands
  // in the month it displays under.
  return events
    .filter((event) => !event.orgFunded && !isCancelledLikeStatus(event.status))
    .reduce(
      (sum, event) =>
        sum +
        groupSlotsIntoSessions(event.slots).filter(
          (s) => formatInViewerZone(s.startTime, zone, "yyyy-MM") === monthKey,
        ).length,
      0,
    );
}

/**
 * Filter and sort events for upcoming display
 */
export function getUpcomingEvents(
  events: ProcessedEvent[],
  now: Date = new Date(),
): ProcessedEvent[] {
  const nowMs = now.getTime();
  // Awaiting rows have no time yet; they sort first because they are the
  // ones blocked on someone.
  const anchor = (e: ProcessedEvent) => e.startsAt?.getTime() ?? -Infinity;
  return events
    .filter(
      (e) =>
        e.needsActionReason !== null ||
        (!!e.joinableOccurrence &&
          getOccurrenceJoinState(e.joinableOccurrence, { now }) !== "ended") ||
        (e.startsAt !== null && e.startsAt.getTime() > nowMs) ||
        liveOccurrencesOf(e.slots).some(
          (s) => s.endsAt.getTime() + REJOIN_GRACE_MS >= nowMs,
        ),
    )
    .sort((a, b) => anchor(a) - anchor(b));
}

/**
 * Home's "Next up" (#1527 QA): booked sessions that can still happen. A
 * cancelled, rejected, expired or finished booking is history, not next.
 */
export function selectNextUp(
  upcoming: ProcessedEvent[],
  limit: number,
): ProcessedEvent[] {
  return upcoming
    .filter((e) => e.startsAt !== null && !isInactiveStatus(e.status))
    .slice(0, limit);
}
