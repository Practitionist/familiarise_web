import type { Prisma, OrgPlanVisibility } from "@prisma/client";

/**
 * Shared traversal for the #366 marketplace routes: Recording → MeetingSession
 * → SlotOfAppointment → Appointment → (Webinar|Class)Plan. Every route used to
 * inline its own four-arm include + fallback chain — Sonar flagged the copy
 * drift as >3% new-code duplication, and duplicated authz selects are exactly
 * how two endpoints end up enforcing different rules.
 */

const listingPlanSelect = {
  id: true,
  // Nullable on the plan models themselves — a plan can outlive its author.
  consultantProfileId: true,
  organizationId: true,
  visibility: true,
  archivedAt: true,
} satisfies Prisma.WebinarPlanSelect;

/** Select fragment for Appointment.webinar / Appointment.class arms. */
export const appointmentPlanArmsSelect = {
  webinar: {
    select: { webinarPlan: { select: listingPlanSelect } },
  },
  class: {
    select: { classPlan: { select: listingPlanSelect } },
  },
} satisfies Prisma.AppointmentSelect;

type PlanArmShape = {
  id: string;
  consultantProfileId: string | null;
  organizationId: string | null;
  visibility: OrgPlanVisibility;
  archivedAt: Date | null;
};

interface AppointmentWithPlans {
  webinar?: { webinarPlan: PlanArmShape | null } | null;
  class?: { classPlan: PlanArmShape | null } | null;
}

export interface ResolvedListingPlan {
  kind: "WEBINAR" | "CLASS";
  plan: PlanArmShape;
}

/**
 * Which group plan owns this appointment, if any. Null for consultation/
 * subscription appointments — those must never reach marketplace surfaces.
 */
export function resolveListingPlan(
  appointment: AppointmentWithPlans,
): ResolvedListingPlan | null {
  const webinarPlan = appointment.webinar?.webinarPlan;
  if (webinarPlan) return { kind: "WEBINAR", plan: webinarPlan };
  const classPlan = appointment.class?.classPlan;
  if (classPlan) return { kind: "CLASS", plan: classPlan };
  return null;
}

// ---------------------------------------------------------------------------
// Storage-policy resolution — used by the transfer route AND by
// handleRecordingReady's premium kick. Covers ALL FOUR plan arms because any
// appointment type can carry a MeetingSession.
// ---------------------------------------------------------------------------

const storagePolicyPlanSelect = {
  consultantProfileId: true,
  recordingStoragePolicy: true,
} satisfies Prisma.ConsultationPlanSelect;

export const appointmentStoragePolicySelect = {
  consultation: {
    select: {
      consultationPlan: { select: storagePolicyPlanSelect },
    },
  },
  subscription: {
    select: {
      subscriptionPlan: { select: storagePolicyPlanSelect },
    },
  },
  webinar: {
    select: {
      webinarPlan: { select: storagePolicyPlanSelect },
    },
  },
  class: {
    select: {
      classPlan: { select: storagePolicyPlanSelect },
    },
  },
} satisfies Prisma.AppointmentSelect;

interface PolicyArm {
  consultantProfileId: string | null;
  recordingStoragePolicy: string;
}

interface AppointmentWithAllPlans {
  consultation?: { consultationPlan: PolicyArm | null } | null;
  subscription?: { subscriptionPlan: PolicyArm | null } | null;
  webinar?: { webinarPlan: PolicyArm | null } | null;
  class?: { classPlan: PolicyArm | null } | null;
}

/**
 * The effective RecordingStoragePolicy for an appointment, and the owning
 * consultant across any arm. Defaults to STREAM_ONLY when no plan arm matches
 * (fail-closed: unknown provenance never earns permanent storage).
 */
export function resolveAppointmentStoragePolicy(
  appointment: AppointmentWithAllPlans,
): { policy: string; ownerProfileId: string | null } {
  const plan =
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan;
  return {
    policy: plan?.recordingStoragePolicy ?? "STREAM_ONLY",
    ownerProfileId: plan?.consultantProfileId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared route loader — the consultant-profile lookup + recording fetch +
// ownership resolution scaffold that publish/preview/purchase each used to
// inline (Sonar flagged the copies; duplicated authz is how endpoints drift).
// ---------------------------------------------------------------------------

import prisma from "@/lib/prisma";

export type OwnedRecordingLoad =
  | { status: "not_found" }
  | { status: "forbidden" }
  | {
      status: "ok";
      recordingId: string;
      recordingStatus: string;
      storageType: string;
      listingStatus: string;
      listPricePaise: bigint | null;
      plan: ResolvedListingPlan;
    };

/**
 * Load a recording that must (a) exist and (b) belong to the caller's
 * consultant profile via its webinar/class plan. Consultation/subscription
 * appointments resolve to `not_found` here — they are not marketplace
 * surfaces and must be invisible to these endpoints.
 */
export async function loadOwnedListingRecording(
  recordingId: string,
  consultantProfileId: string | null | undefined,
): Promise<OwnedRecordingLoad> {
  if (!consultantProfileId) return { status: "forbidden" };

  const recording = await prisma.recording.findUnique({
    where: { id: recordingId },
    select: {
      id: true,
      status: true,
      storageType: true,
      listingStatus: true,
      listPricePaise: true,
      meetingSession: {
        select: {
          slotOfAppointment: {
            select: {
              appointment: { select: appointmentPlanArmsSelect },
            },
          },
        },
      },
    },
  });
  if (!recording) return { status: "not_found" };

  const plan = resolveListingPlan(
    recording.meetingSession.slotOfAppointment.appointment,
  );
  if (!plan) return { status: "not_found" };

  if (plan.plan.consultantProfileId !== consultantProfileId) {
    return { status: "forbidden" };
  }

  return {
    status: "ok",
    recordingId: recording.id,
    recordingStatus: recording.status,
    storageType: recording.storageType,
    listingStatus: recording.listingStatus,
    listPricePaise: recording.listPricePaise,
    plan,
  };
}
