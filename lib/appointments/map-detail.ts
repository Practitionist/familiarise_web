/**
 * Detail-payload mapper: readAppointmentDetail's { appointment }
 * → one AppointmentVM (plus flattened recordings) so the detail page reuses
 * the shared timeline/badge/action machinery. Role decides the counterpart:
 * consultees see the consultant; consultants see the consultee (or the plan
 * host for group events).
 */

import type {
  TAppointmentDetail,
  TDetailAppointment,
} from "@/lib/data/appointment-detail";
import type { TAppointment } from "@/types/appointment";
import { deriveBucket } from "./bucket";
import {
  getAnchorTime,
  isOccurrenceOver,
  liveOccurrences,
} from "./occurrences";
import { occurrencesOfAppointment } from "./occurrences";
import { normalizeStatus } from "./status";
import { trialMeta } from "./trial-labels";
import {
  sortOccurrences,
  toDate,
  type AppointmentVM,
  type PersonVM,
  type OccurrenceLike,
} from "./view-model";

type Role = "consultee" | "consultant";

interface DetailRecordingVM {
  id: string;
  title: string;
  url: string | null;
  thumbnailUrl: string | null;
  status: string;
  durationInMinutes: number;
  recordedAt: Date;
  sessionStartsAt: Date;
}

function person(
  user: { name?: string | null; image?: string | null } | null | undefined,
  fallback: string,
): PersonVM {
  return { name: user?.name ?? fallback, image: user?.image ?? null };
}

function eventOf(appointment: TDetailAppointment): {
  title: string;
  status: string;
  consultant: PersonVM;
  consultantProfileId: string | null;
  consultee: PersonVM | null;
  pendingPaymentUrl: string | null;
  collaborators: AppointmentVM["collaborators"];
} {
  const consultation = appointment.consultation;
  const subscription = appointment.subscription;
  const webinar = appointment.webinar;
  const cls = appointment.cohort;
  const trial = appointment.trial;

  if (trial) {
    return {
      title: trial.subscriptionPlan?.title ?? "Trial",
      status: normalizeStatus(trial.status?.toString()),
      consultant: person(
        trial.subscriptionPlan?.consultantProfile?.user,
        "Unknown Consultant",
      ),
      consultantProfileId:
        trial.subscriptionPlan?.consultantProfile?.id ?? null,
      consultee: person(trial.consulteeProfile?.user, "Unknown User"),
      pendingPaymentUrl: null,
      collaborators: [],
    };
  }
  if (consultation) {
    return {
      title: consultation.consultationPlan?.title ?? "Consultation",
      status: normalizeStatus(consultation.status?.toString()),
      consultant: person(
        consultation.consultationPlan?.consultantProfile?.user,
        "Unknown Consultant",
      ),
      consultantProfileId:
        consultation.consultationPlan?.consultantProfile?.id ?? null,
      consultee: person(consultation.requestedBy?.user, "Unknown User"),
      pendingPaymentUrl: consultation.pendingPaymentUrl ?? null,
      collaborators: [],
    };
  }
  if (subscription) {
    return {
      title: subscription.subscriptionPlan?.title ?? "Subscription",
      status: normalizeStatus(subscription.status?.toString()),
      consultant: person(
        subscription.subscriptionPlan?.consultantProfile?.user,
        "Unknown Consultant",
      ),
      consultantProfileId:
        subscription.subscriptionPlan?.consultantProfile?.id ?? null,
      consultee: person(subscription.requestedBy?.user, "Unknown User"),
      pendingPaymentUrl: subscription.pendingPaymentUrl ?? null,
      collaborators: [],
    };
  }
  const plan = webinar?.webinarPlan ?? cls?.cohortPlan;
  return {
    title: plan?.title ?? (webinar ? "Webinar" : "Class"),
    status: normalizeStatus((webinar?.status ?? cls?.status)?.toString()),
    consultant: person(plan?.consultantProfile?.user, "Unknown Consultant"),
    consultantProfileId: plan?.consultantProfile?.id ?? null,
    consultee: null,
    pendingPaymentUrl: null,
    collaborators: (plan?.collaborators ?? []).map((c) => ({
      name: c.consultantProfile?.user?.name ?? "Collaborator",
      image: c.consultantProfile?.user?.image ?? null,
      role: c.role ?? "",
    })),
  };
}

export function mapAppointmentDetail(
  detail: TAppointmentDetail,
  role: Role,
  now: Date = new Date(),
): { vm: AppointmentVM; recordings: DetailRecordingVM[] } {
  const { appointment } = detail;
  const facts = eventOf(appointment);
  // #1554 — one wrapper per purchase: the programme IS its occurrence rows.
  const all = [appointment];
  const occurrences = sortOccurrences(occurrencesOfAppointment(appointment));

  const isGroup =
    appointment.appointmentType === "SUBSCRIPTION" ||
    appointment.appointmentType === "COHORT";
  // #1554 — progress counts LIVE rows, exactly as map-consultee's
  // groupProgress does, so "2 of 10" reads the same on the list and here.
  const live = liveOccurrences(occurrences);
  const completed = live.filter((s) => isOccurrenceOver(s, now)).length;

  const counterpart =
    role === "consultee"
      ? facts.consultant
      : (facts.consultee ?? facts.consultant);

  const rawOccurrences: OccurrenceLike[] = all
    .flatMap((a) =>
      a.occurrences.map((slot) => ({ ...slot }) as OccurrenceLike),
    )
    .filter((slot) => {
      const end = toDate(slot.endsAt ?? slot.startsAt);
      return end.getTime() >= now.getTime();
    })
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
    );

  const vm: AppointmentVM = {
    id: `appointment-${appointment.id}`,
    appointmentId: appointment.id,
    kind: appointment.appointmentType as AppointmentVM["kind"],
    title: facts.title,
    counterpart,
    consultantProfileId: facts.consultantProfileId,
    status: facts.status,
    ...deriveBucket({ status: facts.status, occurrences, now }),
    nextAt: getAnchorTime(occurrences, now),
    occurrences,
    group: isGroup ? { total: live.length, completed } : null,
    meta: appointment.trial
      ? trialMeta(
          appointment.trial.subscriptionPlan?.trialPriceInPaise ?? null,
          appointment.trial.subscriptionPlan?.trialDurationMinutes ?? null,
        )
      : null,
    organizationId: appointment.organizationId ?? null,
    pendingPaymentUrl: facts.pendingPaymentUrl,
    collaborators: facts.collaborators,
    collaboratorRole: null,
    raw: {
      appointment: appointment as unknown as TAppointment,
      rawOccurrences,
      groupAppointments: all as unknown as TAppointment[],
      source: detail,
    },
  };

  const recordings: DetailRecordingVM[] = all.flatMap((a) =>
    a.occurrences.flatMap((slot) =>
      (slot.meeting?.recordings ?? []).map((rec) => ({
        id: rec.id,
        title: rec.title,
        url: rec.storageUrl ?? rec.recordingUrl ?? null,
        thumbnailUrl: rec.thumbnailUrl ?? null,
        status: rec.status?.toString() ?? "READY",
        durationInMinutes: rec.durationInMinutes,
        recordedAt: toDate(rec.recordedAt),
        sessionStartsAt: toDate(slot.startsAt),
      })),
    ),
  );
  recordings.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());

  return { vm, recordings };
}

export type { DetailRecordingVM };
