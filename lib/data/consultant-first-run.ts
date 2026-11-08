import type {
  ConsultantVerificationStatus,
  Prisma,
  ScheduleType,
} from "@prisma/client";

import {
  eventPlanDiscoverableWhere,
  oneOnOnePlanDiscoverableWhere,
} from "@/lib/api/plans/visibility";
import {
  deriveConsultantChecklist,
  type ConsultantChecklistSnapshot,
} from "@/lib/dashboard/consultant-checklist";
import type { ActivationStep } from "@/lib/enterprise/org-activation";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { payoutRequirements } from "@/lib/payments/payouts/payout-requirements";

/**
 * The Home checklist's inputs ride the loader's own profile read, so a fully
 * set-up expert pays no extra round trip. The payout inputs go straight into
 * the pure `payoutRequirements`; no earnings count is needed because the
 * checklist treats due-now and due-later requirements alike.
 */

export const FIRST_RUN_PROFILE_SELECT = {
  description: true,
  headline: true,
  experience: true,
  verificationStatus: true,
  scheduleType: true,
  taxInfo: {
    select: {
      panLast4: true,
      gstin: true,
      taxEntityType: true,
      isIndianResident: true,
    },
  },
  payoutAccounts: {
    where: { isDefault: true },
    select: { isVerified: true },
    take: 1,
  },
  _count: {
    select: {
      subDomains: true,
      tags: true,
      availabilityWindowsWeekly: true,
      availabilityWindowsCustom: true,
      consultationPlans: { where: oneOnOnePlanDiscoverableWhere() },
      subscriptionPlans: { where: oneOnOnePlanDiscoverableWhere() },
      webinarPlans: { where: eventPlanDiscoverableWhere() },
      classPlans: { where: eventPlanDiscoverableWhere() },
      digitalProducts: { where: { status: "PUBLISHED" } },
    },
  },
} satisfies Prisma.ConsultantProfileSelect;

export const FIRST_RUN_USER_SELECT = {
  image: true,
  profileDisplayImage: true,
  _count: { select: { workExperiences: true } },
} satisfies Prisma.UserSelect;

export interface FirstRunRow {
  description: string | null;
  headline: string | null;
  experience: number | null;
  verificationStatus: ConsultantVerificationStatus;
  scheduleType: ScheduleType;
  taxInfo: {
    panLast4: string | null;
    gstin: string | null;
    taxEntityType: string | null;
    isIndianResident: boolean;
  } | null;
  payoutAccounts: { isVerified: boolean }[];
  _count: {
    subDomains: number;
    tags: number;
    availabilityWindowsWeekly: number;
    availabilityWindowsCustom: number;
    consultationPlans: number;
    subscriptionPlans: number;
    webinarPlans: number;
    classPlans: number;
    digitalProducts: number;
  };
  user: {
    image: string | null;
    profileDisplayImage: string | null;
    _count: { workExperiences: number };
  };
}

/** The open checklist, or null once every step is done. */
export function readFirstRunSteps(
  row: FirstRunRow,
  consultantProfileId: string,
): ActivationStep[] | null {
  const c = row._count;
  const snapshot: ConsultantChecklistSnapshot = {
    verificationStatus: row.verificationStatus,
    profile: {
      description: row.description,
      headline: row.headline,
      experience: row.experience,
      hasDomainDetail: c.subDomains + c.tags > 0,
      hasWorkExperience: row.user._count.workExperiences > 0,
      hasImage: Boolean(row.user.image || row.user.profileDisplayImage),
    },
    hasAvailability:
      row.scheduleType === "WEEKLY"
        ? c.availabilityWindowsWeekly > 0
        : c.availabilityWindowsCustom > 0,
    hasPublishedOffering:
      c.consultationPlans +
        c.subscriptionPlans +
        c.webinarPlans +
        c.classPlans +
        c.digitalProducts >
      0,
    payout: payoutRequirements({
      consultantProfileId,
      taxInfo: row.taxInfo,
      defaultAccount: row.payoutAccounts[0] ?? null,
      earningsCount: 0,
      isIndianResident: row.taxInfo?.isIndianResident ?? true,
      livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
    }),
  };
  const steps = deriveConsultantChecklist(snapshot, consultantProfileId);
  return steps.every((step) => step.done) ? null : steps;
}
