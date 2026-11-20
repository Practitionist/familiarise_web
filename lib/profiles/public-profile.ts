import type { ConsultantVerificationStatus } from "@prisma/client";

/** The expert-profile fields a reader selects to answer `isPublicExpertProfile`; never sent to a client. */
export const publicProfileFacts = {
  verificationStatus: true,
  deletedAt: true,
} as const;

/** Whether `/explore/experts/<id>` serves this profile: the `where` of `getConsultantDetail`. */
export function isPublicExpertProfile(profile: {
  verificationStatus: ConsultantVerificationStatus;
  deletedAt: Date | null;
}): boolean {
  return (
    profile.verificationStatus === "VERIFIED" && profile.deletedAt === null
  );
}
