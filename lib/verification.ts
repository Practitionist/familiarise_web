import prisma from "@/lib/prisma";
import { ConsultantVerificationStatus } from "@prisma/client";

/**
 * Check if a consultant is verified
 * @param consultantProfileId - The consultant profile ID
 * @returns Object with isVerified status and verification details
 */
export async function checkConsultantVerification(
  consultantProfileId: string,
): Promise<{
  isVerified: boolean;
  status: ConsultantVerificationStatus;
  message?: string;
}> {
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      verificationStatus: true,
      isVerified: true,
    },
  });

  if (!profile) {
    return {
      isVerified: false,
      status: ConsultantVerificationStatus.PENDING_VERIFICATION,
      message: "Consultant profile not found",
    };
  }

  if (profile.verificationStatus !== ConsultantVerificationStatus.VERIFIED) {
    const statusMessages: Record<ConsultantVerificationStatus, string> = {
      PENDING_VERIFICATION:
        "Your profile needs to be verified before you can perform this action.",
      UNDER_REVIEW:
        "Your verification is under review. Please wait for approval.",
      VERIFIED: "",
      REJECTED:
        "Your verification was rejected. Please resubmit your verification.",
    };

    return {
      isVerified: false,
      status: profile.verificationStatus,
      message: statusMessages[profile.verificationStatus],
    };
  }

  return {
    isVerified: true,
    status: ConsultantVerificationStatus.VERIFIED,
  };
}

/**
 * Check verification by user ID (looks up consultant profile)
 * @param userId - The user ID
 * @returns Object with isVerified status and verification details
 */
export async function checkConsultantVerificationByUserId(
  userId: string,
): Promise<{
  isVerified: boolean;
  status: ConsultantVerificationStatus | null;
  consultantProfileId?: string;
  message?: string;
}> {
  const profile = await prisma.consultantProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      verificationStatus: true,
      isVerified: true,
    },
  });

  if (!profile) {
    return {
      isVerified: false,
      status: null,
      message: "Consultant profile not found",
    };
  }

  const result = await checkConsultantVerification(profile.id);
  return {
    ...result,
    consultantProfileId: profile.id,
  };
}
