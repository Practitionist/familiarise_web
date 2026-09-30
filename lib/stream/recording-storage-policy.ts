import type { Prisma } from "@prisma/client";

/**
 * Recording storage-policy resolution — ONE definition, three shapes.
 *
 * D5 — `recordingStoragePolicy` exists on all four plan models
 * (`ConsultationPlan`, `SubscriptionPlan`, `WebinarPlan`, `ClassPlan`), but the
 * automatic transfer pipeline, the backlog count and the STREAM_ONLY expiry
 * warning each re-listed the arms themselves, and all three listed only
 * `webinar` and `class`. Only the MANUAL transfer route resolved all four (via
 * `resolveAppointmentStoragePolicy`). The two paths therefore disagreed about
 * the same recording:
 *
 *   - a `PERMANENT` consultation or subscription plan was STREAM_ONLY to the
 *     automatic pipeline, so it was never auto-transferred at ready time and
 *     never counted by the backlog alert — while the manual route would happily
 *     transfer the very same recording on request;
 *   - and it was still flipped to EXPIRED by markExpiredRecordings, which asks
 *     whether the bytes are gone and correctly does not consult a policy.
 *   - a `STREAM_ONLY` 1:1 got no expiry warning at all, which is the exact case
 *     where the consultant most needs to be told to download it first.
 *
 * This module exists as a LEAF on purpose. `recording-listing-access.ts` holds
 * the marketplace route scaffolding and imports `next/server` and
 * `lib/auth-server` at module scope; the transfer service is loaded by four
 * crons, and a cron process that pulls `better-auth` in through a transitive
 * import dies during module evaluation (the same class of failure as the
 * `import "server-only"` marker documented in `recording-storage.ts`, and the
 * reason that file reads its clients from `supabase-storage-core`).
 * `recording-listing-access.ts` re-exports everything here, so route-level
 * importers are unaffected and the row resolver and the two query shapes can
 * never drift apart again.
 */

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

/**
 * Every plan kind that can carry a `recordingStoragePolicy`. One list: the row
 * resolver below and the query filter share it, so a fifth plan kind added in a
 * future migration is picked up in both shapes at once.
 */
const STORAGE_POLICY_ARMS = [
  "consultation",
  "subscription",
  "webinar",
  "class",
] as const satisfies readonly (keyof Prisma.AppointmentSelect)[];

/**
 * `Appointment` filter matching rows whose underlying plan carries `policy`.
 *
 * The arms are an OR of single-arm ANDs (an array of objects is an AND in
 * Prisma), never a flat list of arms: an Appointment can carry more than one
 * plan relation, and an AND would require ALL of them to match — which would
 * drop a PERMANENT webinar whose class relation also exists holding the default
 * STREAM_ONLY, i.e. reintroduce the D5 bug with a different trigger.
 */
export function appointmentStoragePolicyWhere(
  policy: string,
): Prisma.AppointmentWhereInput {
  return {
    OR: STORAGE_POLICY_ARMS.map((arm) => ({
      [arm]: {
        [`${arm}Plan`]: { recordingStoragePolicy: policy },
      },
    })),
  } as Prisma.AppointmentWhereInput;
}

interface PolicyArm {
  consultantProfileId: string | null;
  recordingStoragePolicy: string;
}

export interface AppointmentWithAllPlans {
  consultation?: { consultationPlan: PolicyArm | null } | null;
  subscription?: { subscriptionPlan: PolicyArm | null } | null;
  webinar?: { webinarPlan: PolicyArm | null } | null;
  class?: { classPlan: PolicyArm | null } | null;
}

/**
 * The effective RecordingStoragePolicy for an appointment, and the owning
 * consultant across any arm. Defaults to STREAM_ONLY when no plan arm matches
 * (fail-closed: unknown provenance never earns permanent storage).
 *
 * The precedence below and `STORAGE_POLICY_ARMS` are the same list. An
 * appointment belongs to exactly one plan kind in practice; the chain exists so
 * that a row with a dangling extra relation still resolves rather than falling
 * through to the STREAM_ONLY default.
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
