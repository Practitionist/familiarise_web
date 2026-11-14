/**
 * Consultee mapper: TConsulteeEventsResponse (the 5-type grouped union from
 * readConsulteeEvents) → AppointmentVM[]. Subscriptions and classes collapse
 * to ONE group row each; their per-session detail lives in vm.occurrences.
 */

import { withLapsedRequestRestored } from "@/lib/appointments/lapsed-move";
import type { TAppointment } from "@/types/appointment";
import type {
  TConsulteeEventsResponse,
  TConsulteeWebinar,
  TConsulteeClass,
} from "@/types/consultee-events";
import type {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";
import { deriveBucket } from "./bucket";
import { normalizeOccurrences } from "./normalize";
import {
  REJOIN_GRACE_MS,
  getAnchorTime,
  isDeadOccurrence,
  isDeliberateEnd,
  isOccurrenceOver,
  liveOccurrences,
  occurrencesOfAppointment,
} from "./occurrences";
import {
  isReleasedSeat,
  isUnpaidSeat,
  normalizeStatus,
  ownSeatStatusOf,
} from "./status";
import { bookingStatus } from "./booking-status";
import {
  holdOpenFrom,
  listStatusFacts,
  trialHoldFacts,
} from "./list-status-facts";
import { payablePaymentId } from "@/lib/payments/pay-link-href";
import { trialMeta } from "./trial-labels";
import {
  toDate,
  type AppointmentVM,
  type PersonVM,
  type OccurrenceLike,
  type OccurrenceVM,
} from "./view-model";

interface ConsulteeCollaboratorLike {
  consultantProfile: {
    user: { id: string; name: string; image: string | null };
  } | null;
  role: string;
}

function person(
  user: { name?: string | null; image?: string | null } | null | undefined,
): PersonVM {
  return {
    name: user?.name ?? "Unknown Consultant",
    image: user?.image ?? null,
  };
}

function collaborators(
  list: ConsulteeCollaboratorLike[] | undefined,
): AppointmentVM["collaborators"] {
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    name: c.consultantProfile?.user?.name ?? "Collaborator",
    image: c.consultantProfile?.user?.image ?? null,
    role: c.role ?? "",
  }));
}

/**
 * Future/ongoing slots in the shape the existing consultee action hook
 * (useEventActions) receives — mirrors utils/scheduleHelpers.getActualSlots:
 * keep slots whose end + rejoin grace window hasn't passed, sorted ascending.
 */
function actionableSlots(slots: OccurrenceLike[], now: Date): OccurrenceLike[] {
  return normalizeOccurrences(slots)
    .filter((slot) => {
      if (isDeadOccurrence(slot)) return false;
      if (isDeliberateEnd(slot.meeting)) return false;
      const end = slot.endsAt ? toDate(slot.endsAt) : toDate(slot.startsAt);
      const graceMs = slot.endsAt ? REJOIN_GRACE_MS : 0;
      return end.getTime() + graceMs >= now.getTime();
    })
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
    );
}

/** Group progress over the wrapper's live occurrences (#1554): one row is
 *  one session; completed = the row has elapsed. */
function groupProgress(
  occurrences: OccurrenceVM[],
  now: Date,
): { total: number; completed: number } {
  const live = liveOccurrences(occurrences);
  return {
    total: live.length,
    completed: live.filter((s) => isOccurrenceOver(s, now)).length,
  };
}

function mapConsultation(c: TConsultationWithPlan, now: Date): AppointmentVM {
  const occurrences = occurrencesOfAppointment(c.appointment);
  const status = normalizeStatus(c.status?.toString());
  const facts = listStatusFacts(c.appointment, occurrences);
  return {
    id: `consultation-${c.id}`,
    appointmentId: c.appointment?.id ?? null,
    kind: "CONSULTATION",
    title: c.consultationPlan.title,
    counterpart: person(c.consultationPlan.consultantProfile?.user),
    consultantProfileId: c.consultationPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket(
      {
        status,
        occurrences,
        kind: "CONSULTATION",
        now,
        source: c.bookingSource,
        holdOpen: holdOpenFrom(facts, now),
        paid: facts.paid,
        moving: !!facts.reschedule,
      },
      "consultee",
    ),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: null,
    organizationId: c.appointment?.organizationId ?? null,
    pendingPaymentUrl: c.pendingPaymentUrl ?? null,
    pendingPaymentId: payablePaymentId(c.appointment?.payment),
    bookingSource: c.bookingSource,
    ...facts,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      appointment: (c.appointment ?? undefined) as TAppointment | undefined,
      rawOccurrences: actionableSlots(c.appointment?.occurrences ?? [], now),
      source: c,
    },
  };
}

function mapSubscription(s: TSubscriptionWithPlan, now: Date): AppointmentVM {
  // #1554 — one wrapper per subscription, N occurrences.
  const target = s.appointment ?? undefined;
  const occurrences = occurrencesOfAppointment(target);
  const status = normalizeStatus(s.status?.toString());
  const facts = listStatusFacts(target, occurrences);
  return {
    id: `subscription-${s.id}`,
    appointmentId: target?.id ?? null,
    kind: "SUBSCRIPTION",
    title: s.subscriptionPlan.title,
    counterpart: person(s.subscriptionPlan.consultantProfile?.user),
    consultantProfileId: s.subscriptionPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket(
      {
        status,
        occurrences,
        now,
        source: s.bookingSource,
        holdOpen: holdOpenFrom(facts, now),
        paid: facts.paid,
        moving: !!facts.reschedule,
      },
      "consultee",
    ),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: groupProgress(occurrences, now),
    meta: null,
    organizationId: target?.organizationId ?? null,
    pendingPaymentUrl: s.pendingPaymentUrl ?? null,
    pendingPaymentId: payablePaymentId(target?.payment),
    bookingSource: s.bookingSource,
    ...facts,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      appointment: target as TAppointment | undefined,
      rawOccurrences: actionableSlots(target?.occurrences ?? [], now),
      groupAppointments: target ? [target as TAppointment] : [],
      source: s,
    },
  };
}

/**
 * A seat the learner gave back (left, removed or the event cancelled) lists
 * under Cancelled with its reason, with no link, Join or chat: the detail page
 * no longer admits a released seat.
 */
function withReleasedSeat(
  vm: AppointmentVM,
  eventStatus: string | null | undefined,
  appointment:
    | {
        id: string;
        participants?: ReadonlyArray<{
          status: string;
          updatedAt?: Date | string;
        }>;
      }
    | null
    | undefined,
  zone?: string,
): AppointmentVM {
  const seat = appointment?.participants?.[0];
  if (!isReleasedSeat(seat?.status)) return vm;
  const line = bookingStatus(
    {
      kind: vm.kind,
      status: eventStatus,
      seatStatus: seat?.status,
      seatReleasedAt: seat?.updatedAt ?? null,
    },
    "CONSULTEE",
    { zone },
  ).line;
  return {
    ...vm,
    appointmentId: null,
    bucket: "cancelled",
    needsActionReason: null,
    meta: line,
    raw: { ...vm.raw, rawOccurrences: [] },
  };
}

function mapWebinar(
  w: TConsulteeWebinar,
  now: Date,
  zone?: string,
): AppointmentVM {
  const occurrences = occurrencesOfAppointment(w.appointment);
  const status = normalizeStatus(w.status?.toString());
  const seatStatus = ownSeatStatusOf(w.appointment);
  const facts = listStatusFacts(w.appointment, occurrences);
  const vm: AppointmentVM = {
    id: `webinar-${w.id}`,
    appointmentId: w.appointment?.id ?? null,
    kind: "WEBINAR",
    title: w.webinarPlan.title,
    counterpart: person(w.webinarPlan.consultantProfile?.user),
    consultantProfileId: w.webinarPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket(
      {
        status,
        occurrences,
        now,
        unpaidSeat: isUnpaidSeat({ seatStatus, paid: facts.paid }),
        holdOpen: holdOpenFrom(facts, now),
      },
      "consultee",
    ),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: null,
    organizationId: w.appointment?.organizationId ?? null,
    pendingPaymentUrl: null,
    seatStatus,
    ...facts,
    // The learner's own held order, so a seat they must pay has a Pay link.
    pendingPaymentId: payablePaymentId(w.appointment?.payment),
    collaborators: collaborators(w.webinarPlan.collaborators),
    collaboratorRole: null,
    raw: {
      appointment: (w.appointment ?? undefined) as TAppointment | undefined,
      rawOccurrences: actionableSlots(w.appointment?.occurrences ?? [], now),
      source: w,
    },
  };
  return withReleasedSeat(vm, w.status, w.appointment, zone);
}

function mapClass(c: TConsulteeClass, now: Date, zone?: string): AppointmentVM {
  // #1554 — one wrapper per class, N occurrences.
  const target = c.appointment ?? undefined;
  const occurrences = occurrencesOfAppointment(target);
  const status = normalizeStatus(c.status?.toString());
  const seatStatus = ownSeatStatusOf(target);
  const facts = listStatusFacts(target, occurrences);
  const vm: AppointmentVM = {
    id: `class-${c.id}`,
    appointmentId: target?.id ?? null,
    kind: "CLASS",
    title: c.classPlan.title,
    counterpart: person(c.classPlan.consultantProfile?.user),
    consultantProfileId: c.classPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket(
      {
        status,
        occurrences,
        now,
        unpaidSeat: isUnpaidSeat({ seatStatus, paid: facts.paid }),
        holdOpen: holdOpenFrom(facts, now),
      },
      "consultee",
    ),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: groupProgress(occurrences, now),
    meta: null,
    organizationId: target?.organizationId ?? null,
    pendingPaymentUrl: null,
    seatStatus,
    ...facts,
    // The learner's own held order, so a seat they must pay has a Pay link.
    pendingPaymentId: payablePaymentId(target?.payment),
    collaborators: collaborators(c.classPlan.collaborators),
    collaboratorRole: null,
    raw: {
      appointment: target as unknown as TAppointment | undefined,
      rawOccurrences: actionableSlots(target?.occurrences ?? [], now),
      groupAppointments: target ? [target as unknown as TAppointment] : [],
      source: c,
    },
  };
  return withReleasedSeat(vm, c.status, target, zone);
}

function mapTrial(t: TTrialWithPlan, now: Date): AppointmentVM {
  const occurrences = occurrencesOfAppointment(t.appointment);
  const status = normalizeStatus(t.status);
  const hold = trialHoldFacts(t);
  const holdOpen = holdOpenFrom(hold, now);
  return {
    id: `trial-${t.id}`,
    trialId: t.id,
    appointmentId: t.appointment?.id ?? null,
    kind: "TRIAL",
    title: t.subscriptionPlan.title,
    counterpart: person(t.subscriptionPlan.consultantProfile?.user),
    consultantProfileId: t.subscriptionPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, occurrences, now, holdOpen }, "consultee"),
    ...hold,
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: trialMeta(
      t.subscriptionPlan.trialPriceInPaise,
      t.subscriptionPlan.trialDurationMinutes,
    ),
    organizationId: t.appointment?.organizationId ?? null,
    // Paid trials carry a live pay-link while AWAITING_PAYMENT; fall back to
    // the branded trial checkout route when no hosted URL was stored.
    // Only while the window is open: the checkout refuses a lapsed trial.
    pendingPaymentUrl:
      holdOpen === false
        ? null
        : (t.pendingPaymentUrl ??
          (status === "AWAITING_PAYMENT"
            ? `/checkout/plans/trial/${t.id}`
            : null)),
    pendingPaymentId: payablePaymentId(
      (t.appointment as { payment?: unknown } | null)?.payment as Parameters<
        typeof payablePaymentId
      >[0],
    ),
    collaborators: [],
    collaboratorRole: null,
    raw: {
      appointment: (t.appointment ?? undefined) as TAppointment | undefined,
      rawOccurrences: actionableSlots(t.appointment?.occurrences ?? [], now),
      source: t,
    },
  };
}

export function mapConsulteeEvents(
  data: TConsulteeEventsResponse | undefined,
  now: Date = new Date(),
  /** The viewer's profile zone, for the dates in a released seat's reason line. */
  zone?: string,
): AppointmentVM[] {
  if (!data) return [];
  return [
    ...(data.consultations ?? []).map((c) =>
      mapConsultation(withLapsedRequestRestored(c, now), now),
    ),
    ...(data.subscriptions ?? []).map((s) =>
      mapSubscription(withLapsedRequestRestored(s, now), now),
    ),
    ...(data.webinars ?? []).map((w) => mapWebinar(w, now, zone)),
    ...(data.classes ?? []).map((c) => mapClass(c, now, zone)),
    ...(data.trials ?? []).map((t) => mapTrial(t, now)),
  ];
}
