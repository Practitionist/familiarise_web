"use server";

import prisma from "@/lib/prisma";
import {
  Prisma,
  ConsultationMode,
  ScheduleType,
  UserRole,
  DayOfWeek,
} from "@prisma/client";
import { z } from "zod";
import { experienceValidation } from "@/schemas/shared";
import { isValidTimeRange } from "@/utils/timeSlotValidation";

// #region Zod Schema Definitions

const SlotWeeklyCreateInputSchema = z.object({
  dayOfWeekforStartTimeInUTC: z.nativeEnum(DayOfWeek),
  slotStartTimeInUTC: z.string(), // Specific time format validation can be added if needed
  dayOfWeekforEndTimeInUTC: z.nativeEnum(DayOfWeek),
  slotEndTimeInUTC: z.string(),
});

const SlotCustomCreateInputSchema = z.object({
  slotStartTimeInUTC: z
    .string()
    .datetime({ message: "Invalid start datetime string for custom slot" }),
  slotEndTimeInUTC: z
    .string()
    .datetime({ message: "Invalid end datetime string for custom slot" }),
});

const ConsultantProfileRelatedSubDomainsInputSchema = z.object({
  connect: z.array(z.object({ id: z.string() })).optional(),
  set: z.array(z.object({ id: z.string() })).optional(), // For updates to clear relations
});

const ConsultantProfileRelatedTagsInputSchema = z.object({
  connect: z.array(z.object({ id: z.string() })).optional(),
  set: z.array(z.object({ id: z.string() })).optional(), // For updates to clear relations
});

const BaseConsultantProfileCreateInputSchema = z.object({
  description: z.string().optional(),
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
  experience: experienceValidation,
  scheduleType: z.nativeEnum(ScheduleType).default(ScheduleType.WEEKLY),
  domain: z.object({ connect: z.object({ id: z.string() }) }),
  subDomains: ConsultantProfileRelatedSubDomainsInputSchema.optional(),
  tags: ConsultantProfileRelatedTagsInputSchema.optional(),
  slotsOfAvailabilityWeekly: z
    .object({ create: z.array(SlotWeeklyCreateInputSchema).optional() })
    .optional(),
  slotsOfAvailabilityCustom: z
    .object({ create: z.array(SlotCustomCreateInputSchema).optional() })
    .optional(),
});
// This is separate for the discriminated union to correctly infer types for .create
const ConsultantProfileCreateObjectSchema = z.object({
  create: BaseConsultantProfileCreateInputSchema,
});

const BaseConsulteeProfileCreateInputSchema = z.object({
  education: z.string().optional(),
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredCommunicationMethod: z
    .nativeEnum(ConsultationMode)
    .default(ConsultationMode.VIDEO),
  preferredLanguage: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.union([z.array(z.string()), z.string()]).optional(),
  goals: z.union([z.array(z.string()), z.string()]).optional(),
});
const ConsulteeProfileCreateObjectSchema = z.object({
  create: BaseConsulteeProfileCreateInputSchema,
});

const BaseStaffProfileCreateInputSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.any().optional(),
  responsibilities: z.any().optional(),
});
const StaffProfileCreateObjectSchema = z.object({
  create: BaseStaffProfileCreateInputSchema,
});

const OnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  currentTimezone: z.string().optional(),
});

const OnboardingDataSchema = z.discriminatedUnion("role", [
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.CONSULTANT),
    consultantProfile: ConsultantProfileCreateObjectSchema, // create is required
    consulteeProfile: z.undefined().optional(),
    staffProfile: z.undefined().optional(),
  }),
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.CONSULTEE),
    consultantProfile: z.undefined().optional(),
    consulteeProfile: ConsulteeProfileCreateObjectSchema, // create is required
    staffProfile: z.undefined().optional(),
  }),
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.STAFF),
    consultantProfile: z.undefined().optional(),
    consulteeProfile: z.undefined().optional(),
    staffProfile: StaffProfileCreateObjectSchema, // create is required
  }),
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.ADMIN), // Assuming ADMIN might not have a profile during this onboarding
    consultantProfile: z.undefined().optional(),
    consulteeProfile: z.undefined().optional(),
    staffProfile: z.undefined().optional(),
  }),
]);

// #endregion

// #region TypeScript Types Inferred from Zod Schemas

type OnboardingData = z.infer<typeof OnboardingDataSchema>;
type ConsultantProfileCreateData = z.infer<
  typeof BaseConsultantProfileCreateInputSchema
>;
type ConsulteeProfileCreateData = z.infer<
  typeof BaseConsulteeProfileCreateInputSchema
>;
type StaffProfileCreateData = z.infer<typeof BaseStaffProfileCreateInputSchema>;

// #endregion

// #region Validation Function

function validateOnboardingData(data: any): { success: boolean; data?: OnboardingData; error?: string } {
  try {
    const validatedData = OnboardingDataSchema.parse(data);
    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return { success: false, error: errorMessage };
    }
    return { success: false, error: 'Unknown validation error' };
  }
}

// #endregion

// #region Helper Functions

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
      qualifications: profileData.qualifications ?? "",
      specialization: profileData.specialization ?? "",
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
    },
    update: {
      description: profileData.description ?? "",
      qualifications: profileData.qualifications ?? "",
      specialization: profileData.specialization ?? "",
      experience: profileData.experience ?? null,
      scheduleType: scheduleTypeEnum,
      domain: { connect: { id: domainId } },
      subDomains: profileData.subDomains?.connect
        ? { set: profileData.subDomains.connect }
        : { set: [] },
      tags: profileData.tags?.connect
        ? { set: profileData.tags.connect }
        : { set: [] },
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
      const validWeeklySlots = weeklySlotsToCreate.filter((slot) =>
        isValidTimeRange(
          slot.slotStartTimeInUTC.split("T")[1]?.slice(0, 5) || "",
          slot.slotEndTimeInUTC.split("T")[1]?.slice(0, 5) || "",
        ),
      );
      if (validWeeklySlots.length > 0) {
        await tx.slotOfAvailabilityWeekly.createMany({
          data: validWeeklySlots.map((slot) => ({
            dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
            slotStartTimeInUTC: slot.slotStartTimeInUTC,
            dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
            slotEndTimeInUTC: slot.slotEndTimeInUTC,
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
          new Date(slot.slotStartTimeInUTC).toTimeString().slice(0, 5),
          new Date(slot.slotEndTimeInUTC).toTimeString().slice(0, 5),
        ),
      );
      if (validCustomSlots.length > 0) {
        await tx.slotOfAvailabilityCustom.createMany({
          data: validCustomSlots.map((slot) => ({
            slotStartTimeInUTC: slot.slotStartTimeInUTC,
            slotEndTimeInUTC: slot.slotEndTimeInUTC,
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
      education: profileData.education ?? "",
      occupation: profileData.occupation ?? "",
      aboutMe: profileData.aboutMe ?? "",
      preferredCommunicationMethod: profileData.preferredCommunicationMethod,
      preferredLanguage: profileData.preferredLanguage ?? "",
      specialRequirements: profileData.specialRequirements ?? "",
      interests: interests,
      goals: goals,
    },
    update: {
      education: profileData.education ?? "",
      occupation: profileData.occupation ?? "",
      aboutMe: profileData.aboutMe ?? "",
      preferredCommunicationMethod: profileData.preferredCommunicationMethod,
      preferredLanguage: profileData.preferredLanguage ?? "",
      specialRequirements: profileData.specialRequirements ?? "",
      interests: interests,
      goals: goals,
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
    },
    update: {
      department: profileData.department ?? "",
      position: profileData.position ?? "",
      permissions: profileData.permissions ?? {},
      responsibilities: profileData.responsibilities ?? {},
    },
  });
  return { staffProfileId: staffProfile.id };
}

async function updateUserProfileAndGetFkData(
  userId: string,
  validatedBody: OnboardingData,
  tx: Prisma.TransactionClient,
): Promise<{
  consultantProfileId?: string;
  consulteeProfileId?: string;
  staffProfileId?: string;
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
      return {};
    default:
      throw new Error(
        `Invalid role encountered after validation: ${(validatedBody as any).role}`,
      );
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
