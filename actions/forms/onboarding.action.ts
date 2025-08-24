"use server";

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  validateOnboardingData,
  updateUserProfileAndGetFkData,
  type OnboardingData,
} from "@/utils/onboarding";

// #region Helper Functions

async function getExistingUserForValidation(id: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id },
  });
  if (!existingUser) {
    throw new Error("User not found");
  }
}

// #endregion

// #region Main Server Action
export async function updateOnboardingInformationAction(
  userId: string,
  body: any,
): Promise<{ success: boolean; user?: any; error?: string }> {
  try {
    console.log("Server Action: updateOnboardingInformationAction - Received", {
      userId,
      bodyPreview:
        typeof body === "object" && body !== null
          ? { ...body, consultantProfile: "..." }
          : body,
    });

    const validationResult = validateOnboardingData(body);

    if (!validationResult.success) {
      console.error("Validation Error:", validationResult.error);
      return { success: false, error: validationResult.error };
    }

    const validatedBody = validationResult.data as OnboardingData;

    await getExistingUserForValidation(userId);

    const updatedUser = await prisma.$transaction(async (tx) => {
      const baseUserData: Prisma.UserUpdateInput = {
        name: validatedBody.name,
        email: validatedBody.email,
        phone: validatedBody.phone,
        address: validatedBody.address,
        role: validatedBody.role,
        onboardingCompleted: true,
        currentTimezone: validatedBody.currentTimezone,
        consultantProfileId: null,
        consulteeProfileId: null,
        staffProfileId: null,
      };

      const profileFkData = await updateUserProfileAndGetFkData(
        userId,
        validatedBody,
        tx,
      );

      const finalUserData: Prisma.UserUpdateInput = {
        ...baseUserData,
        ...profileFkData,
      };

      return tx.user.update({
        where: { id: userId },
        data: finalUserData,
        include: {
          consultantProfile: {
            include: {
              slotsOfAvailabilityWeekly: true,
              slotsOfAvailabilityCustom: true,
              domain: true,
              subDomains: true,
              tags: true,
            },
          },
          consulteeProfile: true,
          staffProfile: true,
        },
      });
    });

    return { success: true, user: updatedUser };
  } catch (error: unknown) {
    console.error("Error in updateOnboardingInformationAction:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unknown error occurred while updating onboarding information.";

    if (error instanceof Error) {
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    } else {
      console.error("Unknown error object:", error);
    }
    return { success: false, error: errorMessage };
  }
}
// #endregion
