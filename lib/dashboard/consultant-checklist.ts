import type { ConsultantVerificationStatus } from "@prisma/client";

import type { ActivationStep } from "@/lib/enterprise/org-activation";
import {
  PROFILE_COMPLETION_WEIGHTS,
  calculateProfileCompletion,
  type ProfileCompletionInput,
} from "@/lib/profiles/profile-completion";
import type { PayoutRequirements } from "@/lib/payments/payouts/payout-requirements";

/**
 * The expert's first-run checklist on Home. Pure over a snapshot, in the shape
 * of the org `deriveActivationChecklist`, so one component renders both.
 */

/** Profile fields only: availability, plan and verification are their own steps. */
type ProfileFieldInputs = Pick<
  ProfileCompletionInput,
  | "description"
  | "headline"
  | "experience"
  | "hasDomainDetail"
  | "hasWorkExperience"
  | "hasImage"
>;

export interface ConsultantChecklistSnapshot {
  verificationStatus: ConsultantVerificationStatus;
  profile: ProfileFieldInputs;
  /** Availability rows for the schedule type the expert actually runs. */
  hasAvailability: boolean;
  /** A discoverable 1:1, subscription, webinar or class plan, or a published product. */
  hasPublishedOffering: boolean;
  payout: Pick<
    PayoutRequirements,
    "currentlyDue" | "eventuallyDue" | "blocked"
  >;
}

const PROFILE_FIELDS_MAX =
  100 -
  PROFILE_COMPLETION_WEIGHTS.availability -
  PROFILE_COMPLETION_WEIGHTS.plan -
  PROFILE_COMPLETION_WEIGHTS.verified;

export function profileFieldsComplete(profile: ProfileFieldInputs): boolean {
  return (
    calculateProfileCompletion({
      ...profile,
      hasAvailability: false,
      hasPlan: false,
      isVerified: false,
    }) >= PROFILE_FIELDS_MAX
  );
}

/** A GSTIN is only ever eventually due, so it never holds this step open. */
export function payoutAccountReady(
  payout: ConsultantChecklistSnapshot["payout"],
): boolean {
  return (
    !payout.blocked &&
    [...payout.currentlyDue, ...payout.eventuallyDue].every(
      (requirement) => requirement.code === "GSTIN",
    )
  );
}

export function deriveConsultantChecklist(
  s: ConsultantChecklistSnapshot,
  consultantId: string,
): ActivationStep[] {
  const base = `/dashboard/consultant/${consultantId}`;
  return [
    {
      key: "verify",
      label: "Get your profile verified",
      done: s.verificationStatus === "VERIFIED",
      href: `${base}/settings/verification`,
    },
    {
      key: "profile",
      label: "Complete your profile",
      done: profileFieldsComplete(s.profile),
      href: `${base}/settings/profile`,
    },
    {
      key: "hours",
      label: "Set your weekly hours",
      done: s.hasAvailability,
      href: `${base}/availability`,
    },
    {
      key: "offering",
      label: "Publish your first offering",
      done: s.hasPublishedOffering,
      href: `${base}/sell/sessions`,
    },
    {
      key: "payout",
      label: "Finish payout setup (bank account, PAN and tax details)",
      done: payoutAccountReady(s.payout),
      href: `${base}/settings/get-paid`,
    },
  ];
}
