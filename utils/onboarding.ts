import { z } from "zod";
import {
  ConsultationMode,
  ScheduleType,
  UserRole,
  DayOfWeek,
  Prisma,
} from "@prisma/client";
import { isValidTimeRange } from "@/utils/timeSlotValidation";

// #region Shared Zod Schema Definitions

export const SlotWeeklyCreateInputSchema = z.object({
  dayOfWeekforStartTimeInUTC: z.nativeEnum(DayOfWeek),
  slotStartTimeInUTC: z.string(),
  dayOfWeekforEndTimeInUTC: z.nativeEnum(DayOfWeek),
  slotEndTimeInUTC: z.string(),
});

export const SlotCustomCreateInputSchema = z.object({
  slotStartTimeInUTC: z
    .string()
    .datetime({ message: "Invalid start datetime string for custom slot" }),
  slotEndTimeInUTC: z
    .string()
    .datetime({ message: "Invalid end datetime string for custom slot" }),
});

export const ConsultantProfileRelatedSubDomainsInputSchema = z.object({
  connect: z.array(z.object({ id: z.string() })).optional(),
  set: z.array(z.object({ id: z.string() })).optional(),
});

export const ConsultantProfileRelatedTagsInputSchema = z.object({
  connect: z.array(z.object({ id: z.string() })).optional(),
  set: z.array(z.object({ id: z.string() })).optional(),
});

export const BaseConsultantProfileCreateInputSchema = z.object({
  description: z.string().optional(),
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
  experience: z
    .number()
    .min(0, "Experience must be at least 0 years")
    .max(50, "Experience cannot exceed 50 years")
    .optional(),
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

export const ConsultantProfileCreateObjectSchema = z.object({
  create: BaseConsultantProfileCreateInputSchema,
});

export const BaseConsulteeProfileCreateInputSchema = z.object({
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

export const ConsulteeProfileCreateObjectSchema = z.object({
  create: BaseConsulteeProfileCreateInputSchema,
});

export const BaseStaffProfileCreateInputSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.any().optional(),
  responsibilities: z.any().optional(),
});

export const StaffProfileCreateObjectSchema = z.object({
  create: BaseStaffProfileCreateInputSchema,
});

export const OnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  currentTimezone: z.string().optional(),
  onlineStatus: z.boolean().optional().default(false),
  onboardingCompleted: z.boolean().optional().default(false),
});

export const OnboardingDataSchema = z.discriminatedUnion("role", [
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.CONSULTANT),
    consultantProfile: ConsultantProfileCreateObjectSchema,
    consulteeProfile: z.undefined().optional(),
    staffProfile: z.undefined().optional(),
  }),
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.CONSULTEE),
    consultantProfile: z.undefined().optional(),
    consulteeProfile: ConsulteeProfileCreateObjectSchema,
    staffProfile: z.undefined().optional(),
  }),
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.STAFF),
    consultantProfile: z.undefined().optional(),
    consulteeProfile: z.undefined().optional(),
    staffProfile: StaffProfileCreateObjectSchema,
  }),
  OnboardingBaseSchema.extend({
    role: z.literal(UserRole.ADMIN),
    consultantProfile: z.undefined().optional(),
    consulteeProfile: z.undefined().optional(),
    staffProfile: z.undefined().optional(),
  }),
]);

// Frontend-compatible schemas (flatter structure)
export const FrontendConsultantProfileSchema = z.object({
  description: z.string().optional(),
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
  experience: z
    .number()
    .min(0, "Experience must be at least 0 years")
    .max(50, "Experience cannot exceed 50 years")
    .optional(),
  scheduleType: z.nativeEnum(ScheduleType).default(ScheduleType.WEEKLY),
  domain: z.object({
    id: z.string(),
    name: z.string(),
  }),
  subDomains: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        domainId: z.string(),
      }),
    )
    .optional(),
  tags: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        domainId: z.string(),
      }),
    )
    .optional(),
  weeklySlots: z.array(SlotWeeklyCreateInputSchema).optional(),
  customSlots: z.array(SlotCustomCreateInputSchema).optional(),
});

export const FrontendConsulteeProfileSchema = z.object({
  education: z.string().optional(),
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredCommunicationMethod: z
    .nativeEnum(ConsultationMode)
    .default(ConsultationMode.VIDEO),
  preferredLanguage: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
});

export const FrontendStaffProfileSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.boolean()).optional(),
});

export const FrontendOnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  currentTimezone: z.string().optional(),
  onlineStatus: z.boolean().default(false),
  onboardingCompleted: z.boolean().default(false),
  role: z.nativeEnum(UserRole),
});

// #endregion

// #region TypeScript Types

export type OnboardingData = z.infer<typeof OnboardingDataSchema>;
export type ConsultantProfileCreateData = z.infer<
  typeof BaseConsultantProfileCreateInputSchema
>;
export type ConsulteeProfileCreateData = z.infer<
  typeof BaseConsulteeProfileCreateInputSchema
>;
export type StaffProfileCreateData = z.infer<
  typeof BaseStaffProfileCreateInputSchema
>;

export type FrontendConsultantProfile = z.infer<
  typeof FrontendConsultantProfileSchema
>;
export type FrontendConsulteeProfile = z.infer<
  typeof FrontendConsulteeProfileSchema
>;
export type FrontendStaffProfile = z.infer<typeof FrontendStaffProfileSchema>;
export type FrontendOnboardingBase = z.infer<
  typeof FrontendOnboardingBaseSchema
>;

export type FrontendOnboardingData = FrontendOnboardingBase & {
  consultantProfile?: FrontendConsultantProfile;
  consulteeProfile?: FrontendConsulteeProfile;
  staffProfile?: FrontendStaffProfile;
};

// #endregion

// #region Frontend Zod Schemas (for react-hook-form)

export const PersonalInfoAndRoleFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  role: z.nativeEnum(UserRole),
  onlineStatus: z.boolean().optional(),
  onboardingCompleted: z.boolean().optional(),
});

export const ConsultantProfileFormSchema = z.object({
  description: z.string().min(1, "Description is required"),
  qualifications: z.string().min(1, "Qualifications are required"),
  specialization: z.string().min(1, "Specialization is required"),
  experience: z
    .number()
    .min(0, "Experience must be at least 0 years")
    .max(50, "Experience cannot exceed 50 years"),
  scheduleType: z.nativeEnum(ScheduleType).optional(),
  domain: z.object({
    id: z.string(),
    name: z.string(),
  }),
  subDomains: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        domainId: z.string(),
      }),
    )
    .optional(),
  tags: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        domainId: z.string(),
      }),
    )
    .optional(),
});

export const ConsulteeProfileFormSchema = z.object({
  education: z.string().min(1, "Education is required"),
  occupation: z.string().min(1, "Occupation is required"),
  aboutMe: z.string().min(1, "About me is required"),
  preferredCommunicationMethod: z.nativeEnum(ConsultationMode),
  preferredLanguage: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
  goals: z.array(z.string()).optional(),
});

export const StaffProfileFormSchema = z.object({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.string()).optional(),
});

export const PreferredScheduleFormSchema = z.object({
  scheduleType: z.nativeEnum(ScheduleType),
  weeklySlots: z
    .array(
      z.object({
        dayOfWeekforStartTimeInUTC: z.nativeEnum(DayOfWeek),
        slotStartTimeInUTC: z.string(),
        dayOfWeekforEndTimeInUTC: z.nativeEnum(DayOfWeek),
        slotEndTimeInUTC: z.string(),
      }),
    )
    .optional(),
  customSlots: z
    .array(
      z.object({
        slotStartTimeInUTC: z.string(),
        slotEndTimeInUTC: z.string(),
      }),
    )
    .optional(),
});

// #endregion

// #region Data Transformation Utilities

export function transformFrontendToServerData(
  frontendData: FrontendOnboardingData,
): OnboardingData {
  const baseData = {
    name: frontendData.name,
    email: frontendData.email,
    phone: frontendData.phone,
    address: frontendData.address,
    currentTimezone: frontendData.currentTimezone,
    onlineStatus: frontendData.onlineStatus,
    onboardingCompleted: frontendData.onboardingCompleted,
    role: frontendData.role,
  };

  switch (frontendData.role) {
    case UserRole.CONSULTANT:
      if (!frontendData.consultantProfile) {
        throw new Error("Consultant profile is required");
      }
      return {
        ...baseData,
        role: UserRole.CONSULTANT,
        consultantProfile: {
          create: transformConsultantProfile(frontendData.consultantProfile),
        },
        consulteeProfile: undefined,
        staffProfile: undefined,
      };

    case UserRole.CONSULTEE:
      if (!frontendData.consulteeProfile) {
        throw new Error("Consultee profile is required");
      }
      return {
        ...baseData,
        role: UserRole.CONSULTEE,
        consultantProfile: undefined,
        consulteeProfile: {
          create: transformConsulteeProfile(frontendData.consulteeProfile),
        },
        staffProfile: undefined,
      };

    case UserRole.STAFF:
      if (!frontendData.staffProfile) {
        throw new Error("Staff profile is required");
      }
      return {
        ...baseData,
        role: UserRole.STAFF,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: {
          create: transformStaffProfile(frontendData.staffProfile),
        },
      };

    case UserRole.ADMIN:
      return {
        ...baseData,
        role: UserRole.ADMIN,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: undefined,
      };

    default:
      throw new Error(`Invalid role: ${frontendData.role}`);
  }
}

function transformConsultantProfile(
  profile: FrontendConsultantProfile,
): ConsultantProfileCreateData {
  return {
    description: profile.description,
    qualifications: profile.qualifications,
    specialization: profile.specialization,
    experience: profile.experience,
    scheduleType: profile.scheduleType,
    domain: {
      connect: { id: profile.domain.id },
    },
    subDomains: profile.subDomains?.length
      ? {
          connect: profile.subDomains.map((sub) => ({ id: sub.id })),
        }
      : undefined,
    tags: profile.tags?.length
      ? {
          connect: profile.tags.map((tag) => ({ id: tag.id })),
        }
      : undefined,
    slotsOfAvailabilityWeekly: profile.weeklySlots?.length
      ? {
          create: profile.weeklySlots,
        }
      : undefined,
    slotsOfAvailabilityCustom: profile.customSlots?.length
      ? {
          create: profile.customSlots,
        }
      : undefined,
  };
}

function transformConsulteeProfile(
  profile: FrontendConsulteeProfile,
): ConsulteeProfileCreateData {
  return {
    education: profile.education,
    occupation: profile.occupation,
    aboutMe: profile.aboutMe,
    preferredCommunicationMethod: profile.preferredCommunicationMethod,
    preferredLanguage: profile.preferredLanguage,
    specialRequirements: profile.specialRequirements,
    interests: profile.interests,
    goals: profile.goals,
  };
}

function transformStaffProfile(
  profile: FrontendStaffProfile,
): StaffProfileCreateData {
  return {
    department: profile.department,
    position: profile.position,
    permissions: profile.permissions,
    responsibilities: profile.responsibilities,
  };
}

// #endregion

// #region Validation Utilities

export function validateOnboardingData(data: any): {
  success: boolean;
  data?: OnboardingData;
  error?: string;
} {
  const validationResult = OnboardingDataSchema.safeParse(data);

  if (!validationResult.success) {
    const errorMessage = validationResult.error.errors
      .map((e) => `Field '${e.path.join(".")}': ${e.message}`)
      .join("; ");
    return { success: false, error: `Invalid input: ${errorMessage}` };
  }

  return { success: true, data: validationResult.data };
}

export function validateFrontendOnboardingData(data: any): {
  success: boolean;
  data?: FrontendOnboardingData;
  error?: string;
} {
  try {
    // Basic validation of required fields
    if (!data.name || !data.email || !data.role) {
      return {
        success: false,
        error: "Missing required fields: name, email, or role",
      };
    }

    // Role-specific validation
    switch (data.role) {
      case UserRole.CONSULTANT:
        if (!data.consultantProfile) {
          return { success: false, error: "Consultant profile is required" };
        }
        if (!data.consultantProfile.domain?.id) {
          return {
            success: false,
            error: "Domain is required for consultant profile",
          };
        }
        break;
      case UserRole.CONSULTEE:
        if (!data.consulteeProfile) {
          return { success: false, error: "Consultee profile is required" };
        }
        break;
      case UserRole.STAFF:
        if (!data.staffProfile) {
          return { success: false, error: "Staff profile is required" };
        }
        break;
    }

    return { success: true, data: data as FrontendOnboardingData };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Validation failed",
    };
  }
}

// #endregion

// #region Database Operation Helpers

export async function updateConsultantProfileAndRelations(
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
      experience: profileData.experience ?? 0,
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
      experience: profileData.experience ?? 0,
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

  // Handle schedule slots
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

export async function updateConsulteeProfileAndRelations(
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

export async function updateStaffProfileAndRelations(
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

export async function updateUserProfileAndGetFkData(
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
