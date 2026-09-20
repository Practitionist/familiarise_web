/**
 * #698 OB-1 — `ConsultantProfile.profileCompletionPercentage` was read in four
 * places and computed nowhere (the seed filled it with random values). One pure
 * function decides the score; `recomputeProfileCompletion` loads the inputs
 * and writes it, and is called wherever an input changes: onboarding, the
 * settings PUT, availability writes, and a verification decision.
 *
 * Weights are a product choice, pinned by a test so they only move on purpose.
 * See docs/onboarding/01-system-reference.md §11.
 */

import type { Tx } from "@/lib/prisma";

export interface ProfileCompletionInput {
  description: string | null;
  headline: string | null;
  experience: number | null;
  hasDomainDetail: boolean;
  hasAvailability: boolean;
  hasPlan: boolean;
  hasWorkExperience: boolean;
  hasImage: boolean;
  isVerified: boolean;
}

export const PROFILE_COMPLETION_WEIGHTS = {
  description: 15,
  headline: 10,
  experience: 5,
  domainDetail: 10,
  availability: 15,
  plan: 15,
  workExperience: 10,
  image: 5,
  verified: 15,
} as const;

const MIN_DESCRIPTION_CHARS = 40;

export function calculateProfileCompletion(
  input: ProfileCompletionInput,
): number {
  const w = PROFILE_COMPLETION_WEIGHTS;
  let score = 0;
  if ((input.description?.trim().length ?? 0) >= MIN_DESCRIPTION_CHARS) {
    score += w.description;
  }
  if (input.headline?.trim()) score += w.headline;
  if (input.experience !== null && input.experience > 0) score += w.experience;
  if (input.hasDomainDetail) score += w.domainDetail;
  if (input.hasAvailability) score += w.availability;
  if (input.hasPlan) score += w.plan;
  if (input.hasWorkExperience) score += w.workExperience;
  if (input.hasImage) score += w.image;
  if (input.isVerified) score += w.verified;
  return Math.min(100, score);
}

type CompletionDb = Pick<Tx, "consultantProfile">;

/** Load the inputs, score them, write the column. Returns the score; -1 if no profile. */
export async function recomputeProfileCompletion(
  db: CompletionDb,
  consultantProfileId: string,
): Promise<number> {
  const profile = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      description: true,
      headline: true,
      experience: true,
      verificationStatus: true,
      user: {
        select: {
          image: true,
          profileDisplayImage: true,
          _count: { select: { workExperiences: true } },
        },
      },
      _count: {
        select: {
          subDomains: true,
          tags: true,
          availabilityWindowsWeekly: { where: { deletedAt: null } },
          availabilityWindowsCustom: { where: { deletedAt: null } },
          consultationPlans: true,
          subscriptionPlans: true,
          webinarPlans: true,
          classPlans: true,
        },
      },
    },
  });
  if (!profile) return -1;
  const c = profile._count;
  const score = calculateProfileCompletion({
    description: profile.description,
    headline: profile.headline,
    experience: profile.experience,
    hasDomainDetail: c.subDomains + c.tags > 0,
    hasAvailability:
      c.availabilityWindowsWeekly + c.availabilityWindowsCustom > 0,
    hasPlan:
      c.consultationPlans +
        c.subscriptionPlans +
        c.webinarPlans +
        c.classPlans >
      0,
    hasWorkExperience: profile.user._count.workExperiences > 0,
    hasImage: Boolean(profile.user.image || profile.user.profileDisplayImage),
    isVerified: profile.verificationStatus === "VERIFIED",
  });
  await db.consultantProfile.update({
    where: { id: consultantProfileId },
    data: { profileCompletionPercentage: score },
  });
  return score;
}
