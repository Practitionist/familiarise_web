/**
 * Consultee mapper: TConsulteeEventsResponse (the 5-type grouped union from
 * readConsulteeEvents) → AppointmentVM[]. Subscriptions and classes collapse
 * to ONE group row each; their per-session detail lives in vm.occurrences.
 */

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
import {
  getAnchorTime,
  isOccurrenceOver,
  liveOccurrences,
  occurrencesOfAppointment,
} from "./occurrences";
import { normalizeStatus } from "./status";
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
 * keep slots whose end hasn't passed, sorted ascending.
 */
function actionableSlots(slots: OccurrenceLike[], now: Date): OccurrenceLike[] {
  return slots
    .filter((slot) => {
      const end = slot.endsAt ? toDate(slot.endsAt) : toDate(slot.startsAt);
      return end.getTime() >= now.getTime();
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
  return {
    id: `consultation-${c.id}`,
    appointmentId: c.appointment?.id ?? null,
    kind: "CONSULTATION",
    title: c.consultationPlan.title,
    counterpart: person(c.consultationPlan.consultantProfile?.user),
    consultantProfileId: c.consultationPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: null,
    organizationId: c.appointment?.organizationId ?? null,
    pendingPaymentUrl: c.pendingPaymentUrl ?? null,
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
  return {
    id: `subscription-${s.id}`,
    appointmentId: target?.id ?? null,
    kind: "SUBSCRIPTION",
    title: s.subscriptionPlan.title,
    counterpart: person(s.subscriptionPlan.consultantProfile?.user),
    consultantProfileId: s.subscriptionPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: groupProgress(occurrences, now),
    meta: null,
    organizationId: target?.organizationId ?? null,
    pendingPaymentUrl: s.pendingPaymentUrl ?? null,
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

function mapWebinar(w: TConsulteeWebinar, now: Date): AppointmentVM {
  const occurrences = occurrencesOfAppointment(w.appointment);
  const status = normalizeStatus(w.status?.toString());
  return {
    id: `webinar-${w.id}`,
    appointmentId: w.appointment?.id ?? null,
    kind: "WEBINAR",
    title: w.webinarPlan.title,
    counterpart: person(w.webinarPlan.consultantProfile?.user),
    consultantProfileId: w.webinarPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: null,
    organizationId: w.appointment?.organizationId ?? null,
    pendingPaymentUrl: null,
    collaborators: collaborators(w.webinarPlan.collaborators),
    collaboratorRole: null,
    raw: {
      appointment: (w.appointment ?? undefined) as TAppointment | undefined,
      rawOccurrences: actionableSlots(w.appointment?.occurrences ?? [], now),
      source: w,
    },
  };
}

function mapClass(c: TConsulteeClass, now: Date): AppointmentVM {
  // #1554 — one wrapper per class, N occurrences.
  const target = c.appointment ?? undefined;
  const occurrences = occurrencesOfAppointment(target);
  const status = normalizeStatus(c.status?.toString());
  return {
    id: `class-${c.id}`,
    appointmentId: target?.id ?? null,
    kind: "CLASS",
    title: c.classPlan.title,
    counterpart: person(c.classPlan.consultantProfile?.user),
    consultantProfileId: c.classPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: groupProgress(occurrences, now),
    meta: null,
    organizationId: target?.organizationId ?? null,
    pendingPaymentUrl: null,
    collaborators: collaborators(c.classPlan.collaborators),
    collaboratorRole: null,
    raw: {
      appointment: target as unknown as TAppointment | undefined,
      rawOccurrences: actionableSlots(target?.occurrences ?? [], now),
      groupAppointments: target ? [target as unknown as TAppointment] : [],
      source: c,
    },
  };
}

function mapTrial(t: TTrialWithPlan, now: Date): AppointmentVM {
  const occurrences = occurrencesOfAppointment(t.appointment);
  const status = normalizeStatus(t.status);
  return {
    id: `trial-${t.id}`,
    appointmentId: t.appointment?.id ?? null,
    kind: "TRIAL",
    title: t.subscriptionPlan.title,
    counterpart: person(t.subscriptionPlan.consultantProfile?.user),
    consultantProfileId: t.subscriptionPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: trialMeta(
      t.subscriptionPlan.trialPriceInPaise,
      t.subscriptionPlan.trialDurationMinutes,
    ),
    organizationId: t.appointment?.organizationId ?? null,
    // Paid trials carry a live pay-link while AWAITING_PAYMENT.
    pendingPaymentUrl: t.pendingPaymentUrl ?? null,
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
): AppointmentVM[] {
  if (!data) return [];
  return [
    ...(data.consultations ?? []).map((c) => mapConsultation(c, now)),
    ...(data.subscriptions ?? []).map((s) => mapSubscription(s, now)),
    ...(data.webinars ?? []).map((w) => mapWebinar(w, now)),
    ...(data.classes ?? []).map((c) => mapClass(c, now)),
    ...(data.trials ?? []).map((t) => mapTrial(t, now)),
  ];
}
