/**
 * Consultant mapper: the flat TAppointment[] list (getConsultantAppointments)
 * plus the trials / unscheduled-events side-queries → AppointmentVM[].
 * Subscription and class appointments sharing a parent collapse to ONE group
 * row (the old AppointmentGroupCard grouping), with per-session detail in
 * vm.occurrences.
 */

import type { TAppointment } from "@/types/appointment";
import { deriveBucket } from "./bucket";
import { occurrencesOfAppointment } from "./occurrences";
import {
  getAnchorTime,
  isOccurrenceOver,
  liveOccurrences,
} from "./occurrences";
import { normalizeStatus } from "./status";
import { trialMeta } from "./trial-labels";
import {
  sortOccurrences,
  toDate,
  type AppointmentVM,
  type PersonVM,
} from "./view-model";

/* Structural inputs — mirror ScheduledTrial / UnscheduledCohort /
 * UnscheduledWebinar from the consultant dashboard types without importing
 * from an app route (lib stays route-agnostic). */

export interface ConsultantTrialLike {
  id: string;
  status: string;
  consulteeProfile: {
    id: string;
    user: { id: string; name: string; image: string | null };
  };
  subscriptionPlan: {
    id: string;
    title: string;
    trialPriceInPaise?: number | null;
  };
  appointment: {
    id: string;
    occurrences: Array<{
      id: string;
      startsAt: string | Date;
      endsAt: string | Date;
    }>;
  } | null;
}

export interface UnscheduledCohortLike {
  id: string;
  status: string;
  cohortPlan: {
    id: string;
    title: string;
    sessionsPerWeek: number;
    sessionDurationInHours: number;
    totalSessions: number;
    consultantProfile?: { user?: { name: string; image: string | null } };
  };
}

export interface UnscheduledWebinarLike {
  id: string;
  status: string;
  webinarPlan: {
    id: string;
    title: string;
    durationInHours: number;
    consultantProfile?: { user?: { name: string; image: string | null } };
  };
}

export interface ConsultantAppointmentsInput {
  appointments: TAppointment[];
  scheduledTrials?: ConsultantTrialLike[];
  unscheduledCohorts?: UnscheduledCohortLike[];
  unscheduledWebinars?: UnscheduledWebinarLike[];
  /** Viewer's consultantProfile id — resolves their collaborator role. */
  consultantId: string;
}

function person(
  user: { name?: string | null; image?: string | null } | null | undefined,
  fallback = "Unknown User",
): PersonVM {
  return { name: user?.name ?? fallback, image: user?.image ?? null };
}

/** Title + counterpart + lifecycle status live on the polymorphic parent. */
function eventFacts(appointment: TAppointment): {
  title: string;
  counterpart: PersonVM;
  status: string;
} {
  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return {
        title:
          appointment.consultation?.consultationPlan?.title ?? "Consultation",
        counterpart: person(appointment.consultation?.requestedBy?.user),
        status: normalizeStatus(appointment.consultation?.status?.toString()),
      };
    case "SUBSCRIPTION":
      return {
        title:
          appointment.subscription?.subscriptionPlan?.title ?? "Subscription",
        counterpart: person(appointment.subscription?.requestedBy?.user),
        status: normalizeStatus(appointment.subscription?.status?.toString()),
      };
    case "WEBINAR":
      return {
        title: appointment.webinar?.webinarPlan?.title ?? "Webinar",
        counterpart: person(
          appointment.webinar?.webinarPlan?.consultantProfile?.user,
          "Unknown Consultant",
        ),
        status: normalizeStatus(appointment.webinar?.status?.toString()),
      };
    case "COHORT":
      return {
        title: appointment.cohort?.cohortPlan?.title ?? "Class",
        counterpart: person(
          appointment.cohort?.cohortPlan?.consultantProfile?.user,
          "Unknown Consultant",
        ),
        status: normalizeStatus(appointment.cohort?.status?.toString()),
      };
    default:
      return {
        title: "Session",
        counterpart: person(null),
        status: "",
      };
  }
}

/** Lifecycle status of an appointment's owning event — for surfaces (home
 *  tab) that render a status pill for a bare TAppointment. */
export function getAppointmentLifecycleStatus(
  appointment: TAppointment,
): string {
  return eventFacts(appointment).status;
}

interface PlanCollaboratorLike {
  consultantProfileId: string;
  role: string;
}

/** The viewer's role on a collaborative webinar/class (HOST for the plan
 *  owner when collaborators exist, the collaborator role otherwise). Mirrors
 *  appointmentHelpers.getCollaboratorRole. */
function collaboratorRoleOf(
  appointment: TAppointment,
  consultantId: string,
): string | null {
  const plan =
    appointment.appointmentType === "WEBINAR"
      ? appointment.webinar?.webinarPlan
      : appointment.appointmentType === "COHORT"
        ? appointment.cohort?.cohortPlan
        : null;
  if (!plan) return null;
  const collaborators = (plan as { collaborators?: PlanCollaboratorLike[] })
    .collaborators;
  if (plan.consultantProfileId === consultantId) {
    return Array.isArray(collaborators) && collaborators.length > 0
      ? "HOST"
      : null;
  }
  if (Array.isArray(collaborators)) {
    const collab = collaborators.find(
      (c) => c.consultantProfileId === consultantId,
    );
    if (collab) return collab.role;
  }
  return null;
}

function firstSlotTime(appointment: TAppointment): number {
  const slot = appointment.occurrences?.[0];
  return slot ? toDate(slot.startsAt).getTime() : Infinity;
}

function nextActionableChild(
  children: TAppointment[],
  now: Date,
): TAppointment | undefined {
  const sorted = [...children].sort(
    (a, b) => firstSlotTime(a) - firstSlotTime(b),
  );
  return (
    sorted.find((c) =>
      occurrencesOfAppointment(c).some((s) => !isOccurrenceOver(s, now)),
    ) ??
    sorted.find((c) => (c.occurrences?.length ?? 0) > 0) ??
    sorted[0]
  );
}

function mapSingle(
  appointment: TAppointment,
  consultantId: string,
  now: Date,
): AppointmentVM {
  const occurrences = sortOccurrences(occurrencesOfAppointment(appointment));
  const { title, counterpart, status } = eventFacts(appointment);
  return {
    id: `appointment-${appointment.id}`,
    // Always the viewing consultant: this is their own list.
    consultantProfileId: consultantId,
    appointmentId: appointment.id,
    kind: appointment.appointmentType as AppointmentVM["kind"],
    title,
    counterpart,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: null,
    organizationId: appointment.organizationId ?? null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: collaboratorRoleOf(appointment, consultantId),
    raw: { appointment, source: appointment },
  };
}

function mapGroup(
  children: TAppointment[],
  consultantId: string,
  now: Date,
): AppointmentVM {
  const first = children[0];
  const occurrences = sortOccurrences(
    children.flatMap((c) => occurrencesOfAppointment(c)),
  );
  const { title, counterpart, status } = eventFacts(first);
  // #1554 — progress is counted over live occurrence rows, not wrappers.
  const live = liveOccurrences(occurrences);
  const completed = live.filter((s) => isOccurrenceOver(s, now)).length;
  const target = nextActionableChild(children, now);
  const groupId =
    first.appointmentType === "SUBSCRIPTION"
      ? `subscription-${first.subscriptionId}`
      : `class-${first.cohortId}`;
  return {
    id: groupId,
    // Always the viewing consultant: this is their own list.
    consultantProfileId: consultantId,
    appointmentId: target?.id ?? first.id,
    kind: first.appointmentType as AppointmentVM["kind"],
    title,
    counterpart,
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: { total: live.length, completed },
    meta: null,
    organizationId: first.organizationId ?? null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: collaboratorRoleOf(first, consultantId),
    raw: {
      appointment: target ?? first,
      groupAppointments: children,
      source: first,
    },
  };
}

function mapTrial(
  t: ConsultantTrialLike,
  consultantId: string,
  now: Date,
): AppointmentVM {
  // A trial's rows are shown as confirmed regardless of the placeholder flag,
  // so the override is applied BEFORE grouping — the grouper splits a run on a
  // change of `isTentative`, and masking afterwards would leave the split.
  const occurrences = occurrencesOfAppointment(
    t.appointment
      ? {
          id: t.appointment.id,
          occurrences: (t.appointment.occurrences ?? []).map((slot) => ({
            ...slot,
            isTentative: false,
          })),
        }
      : null,
  );
  const status = normalizeStatus(t.status);
  return {
    id: `trial-${t.id}`,
    // Always the viewing consultant: this is their own list.
    consultantProfileId: consultantId,
    appointmentId: t.appointment?.id ?? null,
    kind: "TRIAL",
    title: t.subscriptionPlan.title,
    counterpart: person(t.consulteeProfile.user),
    status,
    ...deriveBucket({ status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: null,
    meta: trialMeta(t.subscriptionPlan.trialPriceInPaise ?? null, null),
    organizationId: null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: null,
    raw: { source: t },
  };
}

function mapUnscheduledCohort(
  c: UnscheduledCohortLike,
  consultantId: string,
  now: Date,
): AppointmentVM {
  const status = normalizeStatus(c.status);
  const plan = c.cohortPlan;
  return {
    id: `unscheduled-class-${c.id}`,
    // Always the viewing consultant: this is their own list.
    consultantProfileId: consultantId,
    appointmentId: null,
    kind: "COHORT",
    title: plan.title,
    counterpart: person(plan.consultantProfile?.user, "You"),
    status,
    ...deriveBucket({ status, occurrences: [], isUnscheduled: true, now }),
    nextAt: null,
    occurrences: [],
    group: { total: plan.totalSessions, completed: 0 },
    meta: `${plan.sessionsPerWeek} meeting${plan.sessionsPerWeek !== 1 ? "s" : ""}/week · ${plan.totalSessions} sessions · ${plan.sessionDurationInHours}h each`,
    organizationId: null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: null,
    raw: { source: c },
  };
}

function mapUnscheduledWebinar(
  w: UnscheduledWebinarLike,
  consultantId: string,
  now: Date,
): AppointmentVM {
  const status = normalizeStatus(w.status);
  return {
    id: `unscheduled-webinar-${w.id}`,
    // Always the viewing consultant: this is their own list.
    consultantProfileId: consultantId,
    appointmentId: null,
    kind: "WEBINAR",
    title: w.webinarPlan.title,
    counterpart: person(w.webinarPlan.consultantProfile?.user, "You"),
    status,
    ...deriveBucket({ status, occurrences: [], isUnscheduled: true, now }),
    nextAt: null,
    occurrences: [],
    group: null,
    meta: `Single session · ${w.webinarPlan.durationInHours}h`,
    organizationId: null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: null,
    raw: { source: w },
  };
}

export function mapConsultantAppointments(
  input: ConsultantAppointmentsInput,
  now: Date = new Date(),
): AppointmentVM[] {
  const {
    appointments,
    scheduledTrials = [],
    unscheduledCohorts = [],
    unscheduledWebinars = [],
    consultantId,
  } = input;

  // Group subscription/class children under their parent (one row per
  // program); everything else is a row per appointment.
  const groups = new Map<string, TAppointment[]>();
  for (const appointment of appointments ?? []) {
    const key =
      appointment.appointmentType === "SUBSCRIPTION" &&
      appointment.subscriptionId
        ? `subscription-${appointment.subscriptionId}`
        : appointment.appointmentType === "COHORT" && appointment.cohortId
          ? `class-${appointment.cohortId}`
          : `single-${appointment.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(appointment);
    else groups.set(key, [appointment]);
  }

  const vms: AppointmentVM[] = [];
  for (const [key, children] of Array.from(groups.entries())) {
    if (key.startsWith("single-")) {
      vms.push(mapSingle(children[0], consultantId, now));
    } else {
      children.sort((a, b) => firstSlotTime(a) - firstSlotTime(b));
      vms.push(mapGroup(children, consultantId, now));
    }
  }

  vms.push(...scheduledTrials.map((t) => mapTrial(t, consultantId, now)));
  vms.push(
    ...unscheduledCohorts.map((c) =>
      mapUnscheduledCohort(c, consultantId, now),
    ),
  );
  vms.push(
    ...unscheduledWebinars.map((w) =>
      mapUnscheduledWebinar(w, consultantId, now),
    ),
  );
  return vms;
}
