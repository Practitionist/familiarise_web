import "server-only";
import { Prisma } from "@prisma/client";
import { UserRole, ScheduleType } from "@prisma/client";
import prisma from "@/lib/prisma";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import { notifyNewConsultantApplication } from "@/lib/novu";
import type {
  OnboardingData,
  ConsultantProfileCreateData,
  ConsulteeProfileCreateData,
  StaffProfileCreateData,
  AdminProfileCreateData,
} from "./onboarding";

// #region Database Operation Helpers

async function getExistingUserForValidation(id: string) {
  const existingUser = await prisma.user.findUnique({
    where: { id },
  });
  if (!existingUser) {
    throw new Error("User not found");
  }
}

async function updateConsultantProfileAndRelations(
  userId: string,
  profileData: ConsultantProfileCreateData,
  tx: Prisma.TransactionClient,
) {
  const scheduleTypeEnum = profileData.scheduleType;
  const domainId = profileData.domain.connect.id;

  const consultantProfile = await tx.consultantProfile.upsert({
    where: { userId: userId },
    create: {
      userId: userId,
      description: profileData.description ?? "",
      experience: profileData.experience ?? null,
      scheduleType: scheduleTypeEnum,
      rating: 0,
      domainId: domainId,
      subDomains: profileData.subDomains?.connect
        ? { connect: profileData.subDomains.connect }
        : undefined,
      tags: profileData.tags?.connect
        ? { connect: profileData.tags.connect }
        : undefined,
      // New fields
      headline: profileData.headline ?? null,
      websiteUrl: profileData.websiteUrl || null,
      twitterUrl: profileData.twitterUrl || null,
      githubUrl: profileData.githubUrl || null,
      videoIntroUrl: profileData.videoIntroUrl || null,
      languages: profileData.languages ?? [],
      toolsAndTechnologies: profileData.toolsAndTechnologies ?? [],
      mentoringStyle: profileData.mentoringStyle ?? null,
      sessionTypes: profileData.sessionTypes ?? [],
    },
    update: {
      description: profileData.description ?? "",
      experience: profileData.experience ?? null,
      scheduleType: scheduleTypeEnum,
      domain: { connect: { id: domainId } },
      subDomains: profileData.subDomains?.connect
        ? { set: profileData.subDomains.connect }
        : { set: [] },
      tags: profileData.tags?.connect
        ? { set: profileData.tags.connect }
        : { set: [] },
      // New fields
      headline: profileData.headline ?? null,
      websiteUrl: profileData.websiteUrl || null,
      twitterUrl: profileData.twitterUrl || null,
      githubUrl: profileData.githubUrl || null,
      videoIntroUrl: profileData.videoIntroUrl || null,
      languages: profileData.languages ?? [],
      toolsAndTechnologies: profileData.toolsAndTechnologies ?? [],
      mentoringStyle: profileData.mentoringStyle ?? null,
      sessionTypes: profileData.sessionTypes ?? [],
    },
  });

  if (scheduleTypeEnum === ScheduleType.WEEKLY) {
    await tx.slotOfAvailabilityCustom.deleteMany({
      where: { consultantProfileId: consultantProfile.id },
    });
    await tx.slotOfAvailabilityWeekly.deleteMany({
      where: { consultantProfileId: consultantProfile.id },
    });
    const weeklySlotsToCreate = profileData.slotsOfAvailabilityWeekly?.create;
    if (weeklySlotsToCreate && weeklySlotsToCreate.length > 0) {
      const validWeeklySlots = weeklySlotsToCreate.filter((slot) => {
        // Int-based minutes (0-1439): convert to HH:MM for validation
        const startHH = Math.floor(slot.startTimeUtc / 60)
          .toString()
          .padStart(2, "0");
        const startMM = (slot.startTimeUtc % 60).toString().padStart(2, "0");
        const endHH = Math.floor(slot.endTimeUtc / 60)
          .toString()
          .padStart(2, "0");
        const endMM = (slot.endTimeUtc % 60).toString().padStart(2, "0");
        return isValidTimeRange(
          `${startHH}:${startMM}`,
          `${endHH}:${endMM}`,
        );
      });
      if (validWeeklySlots.length > 0) {
        await tx.slotOfAvailabilityWeekly.createMany({
          data: validWeeklySlots.map((slot) => ({
            startDay: slot.startDay,
            startTimeUtc: slot.startTimeUtc,
            endDay: slot.endDay,
            endTimeUtc: slot.endTimeUtc,
            consultantProfileId: consultantProfile.id,
          })),
        });
      }
    }
  } else if (scheduleTypeEnum === ScheduleType.CUSTOM) {
    await tx.slotOfAvailabilityWeekly.deleteMany({
      where: { consultantProfileId: consultantProfile.id },
    });
    await tx.slotOfAvailabilityCustom.deleteMany({
      where: { consultantProfileId: consultantProfile.id },
    });
    const customSlotsToCreate = profileData.slotsOfAvailabilityCustom?.create;
    if (customSlotsToCreate && customSlotsToCreate.length > 0) {
      const validCustomSlots = customSlotsToCreate.filter((slot) =>
        isValidTimeRange(
          new Date(slot.availabilityStartsAt).toTimeString().slice(0, 5),
          new Date(slot.availabilityEndsAt).toTimeString().slice(0, 5),
        ),
      );
      if (validCustomSlots.length > 0) {
        await tx.slotOfAvailabilityCustom.createMany({
          data: validCustomSlots.map((slot) => ({
            availabilityStartsAt: slot.availabilityStartsAt,
            availabilityEndsAt: slot.availabilityEndsAt,
            consultantProfileId: consultantProfile.id,
          })),
        });
      }
    }
  }
  return { consultantProfileId: consultantProfile.id };
}

async function updateConsulteeProfileAndRelations(
  userId: string,
  profileData: ConsulteeProfileCreateData,
  tx: Prisma.TransactionClient,
) {
  const interests = Array.isArray(profileData.interests)
    ? profileData.interests.join(", ")
    : (profileData.interests ?? "");
  const goals = Array.isArray(profileData.goals)
    ? profileData.goals.join(", ")
    : (profileData.goals ?? "");

  const consulteeProfile = await tx.consulteeProfile.upsert({
    where: { userId: userId },
    create: {
      userId: userId,
      occupation: profileData.occupation ?? "",
      aboutMe: profileData.aboutMe ?? "",
      preferredCommunicationMethod: profileData.preferredCommunicationMethod,
      preferredLanguage: profileData.preferredLanguage ?? "",
      goals: goals,
      // New fields
      careerStage: profileData.careerStage ?? null,
      currentCompany: profileData.currentCompany ?? null,
      industry: profileData.industry ?? null,
      skillsToDevelop: profileData.skillsToDevelop ?? [],
      linkedinUrl: profileData.linkedinUrl || null,
      budgetPreference: profileData.budgetPreference ?? null,
    },
    update: {
      occupation: profileData.occupation ?? "",
      aboutMe: profileData.aboutMe ?? "",
      preferredCommunicationMethod: profileData.preferredCommunicationMethod,
      preferredLanguage: profileData.preferredLanguage ?? "",
      goals: goals,
      // New fields
      careerStage: profileData.careerStage ?? null,
      currentCompany: profileData.currentCompany ?? null,
      industry: profileData.industry ?? null,
      skillsToDevelop: profileData.skillsToDevelop ?? [],
      linkedinUrl: profileData.linkedinUrl || null,
      budgetPreference: profileData.budgetPreference ?? null,
    },
  });
  return { consulteeProfileId: consulteeProfile.id };
}

async function updateStaffProfileAndRelations(
  userId: string,
  profileData: StaffProfileCreateData,
  tx: Prisma.TransactionClient,
) {
  const staffProfile = await tx.staffProfile.upsert({
    where: { userId: userId },
    create: {
      userId: userId,
      department: profileData.department ?? "",
      position: profileData.position ?? "",
      permissions: profileData.permissions ?? {},
      responsibilities: profileData.responsibilities ?? {},
      // New fields
      employeeId: profileData.employeeId ?? null,
      hireDate: profileData.hireDate ?? null,
      reportsTo: profileData.reportsTo ?? null,
      skills: profileData.skills ?? [],
      workSchedule: profileData.workSchedule ?? null,
    },
    update: {
      department: profileData.department ?? "",
      position: profileData.position ?? "",
      permissions: profileData.permissions ?? {},
      responsibilities: profileData.responsibilities ?? {},
      // New fields
      employeeId: profileData.employeeId ?? null,
      hireDate: profileData.hireDate ?? null,
      reportsTo: profileData.reportsTo ?? null,
      skills: profileData.skills ?? [],
      workSchedule: profileData.workSchedule ?? null,
    },
  });
  return { staffProfileId: staffProfile.id };
}

async function updateAdminProfileAndRelations(
  userId: string,
  profileData: AdminProfileCreateData,
  tx: Prisma.TransactionClient,
) {
  const adminProfile = await tx.adminProfile.upsert({
    where: { userId: userId },
    create: {
      userId: userId,
      adminLevel: profileData.adminLevel,
      accessScope: profileData.accessScope ?? null,
      assignedRegions: profileData.assignedRegions ?? [],
      notes: profileData.notes ?? null,
    },
    update: {
      adminLevel: profileData.adminLevel,
      accessScope: profileData.accessScope ?? null,
      assignedRegions: profileData.assignedRegions ?? [],
      notes: profileData.notes ?? null,
    },
  });
  return { adminProfileId: adminProfile.id };
}

async function updateUserProfileAndGetFkData(
  userId: string,
  validatedBody: OnboardingData,
  tx: Prisma.TransactionClient,
): Promise<{
  consultantProfileId?: string;
  consulteeProfileId?: string;
  staffProfileId?: string;
  adminProfileId?: string;
}> {
  switch (validatedBody.role) {
    case UserRole.CONSULTANT:
      return updateConsultantProfileAndRelations(
        userId,
        validatedBody.consultantProfile.create,
        tx,
      );
    case UserRole.CONSULTEE:
      return updateConsulteeProfileAndRelations(
        userId,
        validatedBody.consulteeProfile.create,
        tx,
      );
    case UserRole.STAFF:
      return updateStaffProfileAndRelations(
        userId,
        validatedBody.staffProfile.create,
        tx,
      );
    case UserRole.ADMIN:
      // Admin profiles are optional during onboarding (can be set by super admin later)
      if ((validatedBody as any).adminProfile?.create) {
        return updateAdminProfileAndRelations(
          userId,
          (validatedBody as any).adminProfile.create,
          tx,
        );
      }
      return {};
    default:
      throw new Error(
        `Invalid role encountered after validation: ${(validatedBody as any).role}`,
      );
  }
}

// Central onboarding processing function - SERVER ONLY
export async function processOnboardingData(
  userId: string,
  body: any,
): Promise<{ success: boolean; user?: any; error?: string }> {
  // Import validateOnboardingData dynamically to avoid circular dependencies
  const { validateOnboardingData } = await import("./onboarding");

  try {
    console.log("Central Utils: processOnboardingData - Received", {
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

    const updatedUser = await prisma.$transaction(
      async (tx) => {
        const baseUserData: Prisma.UserUpdateInput = {
          name: validatedBody.name,
          email: validatedBody.email,
          phone: validatedBody.phone,
          address: validatedBody.address,
          role: validatedBody.role,
          onboardingCompleted: true,
          timezone: validatedBody.timezone,
          // New user fields
          dateOfBirth: validatedBody.dateOfBirth ?? null,
          gender: validatedBody.gender ?? null,
          city: validatedBody.city ?? null,
          country: validatedBody.country ?? null,
          linkedinUrl: validatedBody.linkedinUrl || null,
          bio: validatedBody.bio ?? null,
          // Reset profile IDs (will be set by profileFkData)
          consultantProfileId: null,
          consulteeProfileId: null,
          staffProfileId: null,
          adminProfileId: null,
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
            // Professional background is now at User level
            workExperiences: true,
            education: true,
            certifications: true,
            staffProfile: true,
            adminProfile: true,
          },
        });
      },
      {
        maxWait: 10000, // Max time to wait to acquire transaction lock (10s)
        timeout: 30000, // Max transaction execution time (30s)
      },
    );

    // If this is a consultant, submit verification request
    if (
      validatedBody.role === UserRole.CONSULTANT &&
      updatedUser.consultantProfileId
    ) {
      try {
        // Extract verification data from original body (not validated schema)
        const verificationLinkedinUrl = body.verificationLinkedinUrl;
        const verificationNotes = body.verificationNotes;
        const verificationDocuments = body.verificationDocuments;

        // Update user's LinkedIn URL if provided in verification
        if (verificationLinkedinUrl) {
          await prisma.user.update({
            where: { id: userId },
            data: { linkedinUrl: verificationLinkedinUrl },
          });
        }

        // Create verification request
        const verification = await prisma.consultantProfileVerification.create({
          data: {
            consultantProfileId: updatedUser.consultantProfileId,
            notes: verificationNotes || null,
            status: "PENDING",
          },
        });

        // Connect or create uploaded documents for the verification
        if (verificationDocuments && verificationDocuments.length > 0) {
          // Handle documents that have IDs (created before profile existed - legacy)
          const existingDocuments = verificationDocuments.filter(
            (doc: any) => doc.id && !doc.isOnboardingUpload,
          );
          if (existingDocuments.length > 0) {
            const documentIds = existingDocuments.map((doc: any) => doc.id);
            await prisma.profileVerificationDocument.updateMany({
              where: { id: { in: documentIds } },
              data: { verificationId: verification.id },
            });
          }

          // Handle documents uploaded during onboarding (no ID yet, have file info)
          const onboardingDocuments = verificationDocuments.filter(
            (doc: any) => doc.isOnboardingUpload || (!doc.id && doc.fileUrl),
          );
          if (onboardingDocuments.length > 0) {
            await prisma.profileVerificationDocument.createMany({
              data: onboardingDocuments.map((doc: any) => ({
                verificationId: verification.id,
                fileName: doc.fileName,
                originalName: doc.originalName,
                fileSize: doc.fileSize,
                mimeType: doc.mimeType,
                fileUrl: doc.fileUrl,
                storagePath: doc.storagePath,
                description: doc.description || null,
              })),
            });
          }
        }

        // Update consultant profile verification status
        await prisma.consultantProfile.update({
          where: { id: updatedUser.consultantProfileId },
          data: {
            verificationStatus: "UNDER_REVIEW",
            isVerified: false,
          },
        });

        console.log(
          "Verification request created for consultant:",
          updatedUser.consultantProfileId,
        );

        // Fire-and-forget: notify admins of new consultant application
        void (async () => {
          try {
            const admins = await prisma.user.findMany({
              where: { role: UserRole.ADMIN },
              select: { id: true },
            });
            if (admins.length > 0) {
              await notifyNewConsultantApplication(
                admins.map((a) => a.id),
                {
                  applicantName: updatedUser.name || "Unknown",
                  applicantEmail: updatedUser.email || "Unknown",
                  dashboardUrl: "/dashboard/admin/users",
                },
              );
            }
          } catch (notifyError) {
            console.error(
              "[Novu] Failed to notify admins of new consultant application:",
              notifyError,
            );
          }
        })();
      } catch (verificationError) {
        // Log but don't fail the entire onboarding if verification submission fails
        console.error(
          "Failed to create verification request:",
          verificationError,
        );
      }
    }

    return { success: true, user: updatedUser };
  } catch (error: unknown) {
    console.error("Error in processOnboardingData:", error);
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
