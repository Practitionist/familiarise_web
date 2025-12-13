import { z } from "zod";
import {
  ConsultationMode,
  ScheduleType,
  UserRole,
  DayOfWeek,
  Prisma,
  Gender,
  CareerStage,
  AdminLevel,
  BudgetPreference,
  SessionType,
} from "@prisma/client";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import { experienceValidation } from "@/schemas/shared";

// #region Shared Zod Schema Definitions

export const SlotWeeklyCreateInputSchema = z.object({
  dayOfWeekForStartsAt: z.nativeEnum(DayOfWeek),
  availabilityStartsAt: z.string(),
  dayOfWeekForEndsAt: z.nativeEnum(DayOfWeek),
  availabilityEndsAt: z.string(),
});

export const SlotCustomCreateInputSchema = z.object({
  availabilityStartsAt: z
    .string()
    .datetime({ message: "Invalid start datetime string for custom slot" }),
  availabilityEndsAt: z
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
  // New fields
  headline: z.string().max(120).optional(),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  twitterUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  videoIntroUrl: z.string().url().optional().or(z.literal("")),
  languages: z.array(z.string()).default([]),
  toolsAndTechnologies: z.array(z.string()).default([]),
  mentoringStyle: z.string().optional(),
  sessionTypes: z.array(z.nativeEnum(SessionType)).default([]),
  // Deprecated fields (kept for backward compatibility)
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
});

export const ConsultantProfileCreateObjectSchema = z.object({
  create: BaseConsultantProfileCreateInputSchema,
});

export const BaseConsulteeProfileCreateInputSchema = z.object({
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredCommunicationMethod: z
    .nativeEnum(ConsultationMode)
    .default(ConsultationMode.VIDEO),
  preferredLanguage: z.string().optional(),
  goals: z.array(z.string()).optional(),
  // New fields
  careerStage: z.nativeEnum(CareerStage).optional().nullable(),
  currentCompany: z.string().optional(),
  industry: z.string().optional(),
  skillsToDevelop: z.array(z.string()).optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  budgetPreference: z.nativeEnum(BudgetPreference).optional().nullable(),
  // Deprecated fields (kept for backward compatibility)
  education: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
});

export const ConsulteeProfileCreateObjectSchema = z.object({
  create: BaseConsulteeProfileCreateInputSchema,
});

export const BaseStaffProfileCreateInputSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.any().optional(),
  responsibilities: z.any().optional(),
  // New fields
  employeeId: z.string().optional(),
  hireDate: z.coerce.date().optional().nullable(),
  reportsTo: z.string().optional(),
  skills: z.array(z.string()).default([]),
  workSchedule: z.string().optional(),
});

export const StaffProfileCreateObjectSchema = z.object({
  create: BaseStaffProfileCreateInputSchema,
});

// NEW: Admin Profile Schema
export const BaseAdminProfileCreateInputSchema = z.object({
  adminLevel: z.nativeEnum(AdminLevel),
  accessScope: z.any().optional().nullable(),
  assignedRegions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const AdminProfileCreateObjectSchema = z.object({
  create: BaseAdminProfileCreateInputSchema,
});

export const OnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  timezone: z.string().optional(),
  onlineStatus: z.boolean().optional().default(false),
  onboardingCompleted: z.boolean().optional().default(false),
  // New user fields
  dateOfBirth: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(160).optional(),
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
    adminProfile: AdminProfileCreateObjectSchema.optional(),
  }),
]);

// Frontend-compatible schemas (flatter structure)
export const FrontendConsultantProfileSchema = z.object({
  description: z.string().optional(),
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
  // New fields
  headline: z.string().max(120).optional(),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  twitterUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  videoIntroUrl: z.string().url().optional().or(z.literal("")),
  languages: z.array(z.string()).default([]),
  toolsAndTechnologies: z.array(z.string()).default([]),
  mentoringStyle: z.string().optional(),
  sessionTypes: z.array(z.nativeEnum(SessionType)).default([]),
  // Deprecated fields (kept for backward compatibility)
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
});

export const FrontendConsulteeProfileSchema = z.object({
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredCommunicationMethod: z
    .nativeEnum(ConsultationMode)
    .default(ConsultationMode.VIDEO),
  preferredLanguage: z.string().optional(),
  goals: z.array(z.string()).optional(),
  // New fields
  careerStage: z.nativeEnum(CareerStage).optional().nullable(),
  currentCompany: z.string().optional(),
  industry: z.string().optional(),
  skillsToDevelop: z.array(z.string()).optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  budgetPreference: z.nativeEnum(BudgetPreference).optional().nullable(),
  // Deprecated fields (kept for backward compatibility)
  education: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
});

export const FrontendStaffProfileSchema = z.object({
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.boolean()).optional(),
  // New fields
  employeeId: z.string().optional(),
  hireDate: z.coerce.date().optional().nullable(),
  reportsTo: z.string().optional(),
  skills: z.array(z.string()).default([]),
  workSchedule: z.string().optional(),
});

// NEW: Frontend Admin Profile Schema
export const FrontendAdminProfileSchema = z.object({
  adminLevel: z.nativeEnum(AdminLevel),
  accessScope: z.any().optional().nullable(),
  assignedRegions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const FrontendOnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  timezone: z.string().optional(),
  onlineStatus: z.boolean().default(false),
  onboardingCompleted: z.boolean().default(false),
  role: z.nativeEnum(UserRole),
  // New user fields
  dateOfBirth: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(160).optional(),
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
export type AdminProfileCreateData = z.infer<
  typeof BaseAdminProfileCreateInputSchema
>;

export type FrontendConsultantProfile = z.infer<
  typeof FrontendConsultantProfileSchema
>;
export type FrontendConsulteeProfile = z.infer<
  typeof FrontendConsulteeProfileSchema
>;
export type FrontendStaffProfile = z.infer<typeof FrontendStaffProfileSchema>;
export type FrontendAdminProfile = z.infer<typeof FrontendAdminProfileSchema>;
export type FrontendOnboardingBase = z.infer<
  typeof FrontendOnboardingBaseSchema
>;

export type FrontendOnboardingData = FrontendOnboardingBase & {
  consultantProfile?: FrontendConsultantProfile;
  consulteeProfile?: FrontendConsulteeProfile;
  staffProfile?: FrontendStaffProfile;
  adminProfile?: FrontendAdminProfile;
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
  // New user fields
  dateOfBirth: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(160).optional(),
});

export const ConsultantProfileFormSchema = z.object({
  description: z.string().min(1, "Description is required"),
  experience: experienceValidation,
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
  // New fields
  headline: z.string().max(120).optional(),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  twitterUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  videoIntroUrl: z.string().url().optional().or(z.literal("")),
  languages: z.array(z.string()).default([]),
  toolsAndTechnologies: z.array(z.string()).default([]),
  mentoringStyle: z.string().optional(),
  sessionTypes: z.array(z.nativeEnum(SessionType)).default([]),
  // Deprecated fields (kept for backward compatibility)
  qualifications: z.string().optional(),
  specialization: z.string().optional(),
});

export const ConsulteeProfileFormSchema = z.object({
  occupation: z.string().min(1, "Occupation is required"),
  aboutMe: z.string().min(1, "About me is required"),
  preferredCommunicationMethod: z.nativeEnum(ConsultationMode),
  preferredLanguage: z.string().optional(),
  goals: z.array(z.string()).optional(),
  // New fields
  careerStage: z.nativeEnum(CareerStage).optional().nullable(),
  currentCompany: z.string().optional(),
  industry: z.string().optional(),
  skillsToDevelop: z.array(z.string()).optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  budgetPreference: z.nativeEnum(BudgetPreference).optional().nullable(),
  // Deprecated fields (kept for backward compatibility)
  education: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),
});

export const StaffProfileFormSchema = z.object({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.string()).optional(),
  // New fields
  employeeId: z.string().optional(),
  hireDate: z.coerce.date().optional().nullable(),
  reportsTo: z.string().optional(),
  skills: z.array(z.string()).default([]),
  workSchedule: z.string().optional(),
});

// NEW: Admin Profile Form Schema
export const AdminProfileFormSchema = z.object({
  adminLevel: z.nativeEnum(AdminLevel),
  accessScope: z.any().optional().nullable(),
  assignedRegions: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const PreferredScheduleFormSchema = z.object({
  scheduleType: z.nativeEnum(ScheduleType),
  weeklySlots: z.array(SlotWeeklyCreateInputSchema).optional(),
  customSlots: z.array(SlotCustomCreateInputSchema).optional(),
});

// Combined form data type for frontend use
export const OnboardingFormDataSchema = PersonalInfoAndRoleFormSchema.extend({
  // Add missing fields from PersonalInfoAndRole
  timezone: z.string().optional(),
  onlineStatus: z.boolean().default(false),
  onboardingCompleted: z.boolean().default(false),
  emailVerified: z.date().optional(),
  image: z.string().optional(),
  preferredCommunicationMethod: z
    .nativeEnum(ConsultationMode)
    .default(ConsultationMode.VIDEO),

  // Consultant fields
  description: z.string().optional(),
  experience: experienceValidation.optional(),
  domain: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .optional(),
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
  scheduleType: z.nativeEnum(ScheduleType).optional(),
  weeklySlots: z.array(SlotWeeklyCreateInputSchema).optional(),
  customSlots: z.array(SlotCustomCreateInputSchema).optional(),
  // New consultant fields
  headline: z.string().max(120).optional(),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  twitterUrl: z.string().url().optional().or(z.literal("")),
  githubUrl: z.string().url().optional().or(z.literal("")),
  videoIntroUrl: z.string().url().optional().or(z.literal("")),
  languages: z.array(z.string()).optional(),
  toolsAndTechnologies: z.array(z.string()).optional(),
  mentoringStyle: z.string().optional(),
  sessionTypes: z.array(z.nativeEnum(SessionType)).optional(),
  // Deprecated consultant fields
  qualifications: z.string().optional(),
  specialization: z.string().optional(),

  // Consultee fields
  occupation: z.string().optional(),
  aboutMe: z.string().optional(),
  preferredLanguage: z.string().optional(),
  goals: z.array(z.string()).optional(),
  // New consultee fields
  careerStage: z.nativeEnum(CareerStage).optional().nullable(),
  currentCompany: z.string().optional(),
  industry: z.string().optional(),
  skillsToDevelop: z.array(z.string()).optional(),
  budgetPreference: z.nativeEnum(BudgetPreference).optional().nullable(),
  // Deprecated consultee fields
  education: z.string().optional(),
  specialRequirements: z.string().optional(),
  interests: z.array(z.string()).optional(),

  // Staff fields
  department: z.string().optional(),
  position: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.boolean()).optional(),
  // New staff fields
  employeeId: z.string().optional(),
  hireDate: z.coerce.date().optional().nullable(),
  reportsTo: z.string().optional(),
  skills: z.array(z.string()).optional(),
  workSchedule: z.string().optional(),

  // Admin fields (NEW)
  adminLevel: z.nativeEnum(AdminLevel).optional(),
  accessScope: z.any().optional().nullable(),
  assignedRegions: z.array(z.string()).optional(),
  adminNotes: z.string().optional(),

  // Agreement fields
  termsAccepted: z.boolean().optional(),
  privacyAccepted: z.boolean().optional(),
});

export type OnboardingFormData = z.infer<typeof OnboardingFormDataSchema>;

// #endregion

// #region Data Transformation Utilities

export function transformOnboardingFormToServerData(
  formData: OnboardingFormData,
): OnboardingData {
  const baseData = {
    name: formData.name,
    email: formData.email,
    phone: formData.phone,
    address: formData.address,
    timezone:
      formData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    onlineStatus: formData.onlineStatus || false,
    onboardingCompleted: true, // Set to true when completing onboarding
    role: formData.role,
    // New user fields
    dateOfBirth: formData.dateOfBirth,
    gender: formData.gender,
    city: formData.city,
    country: formData.country,
    linkedinUrl: formData.linkedinUrl,
    bio: formData.bio,
  };

  switch (formData.role) {
    case UserRole.CONSULTANT:
      if (!formData.domain?.id) {
        throw new Error("Domain is required for consultant profile");
      }
      return {
        ...baseData,
        role: UserRole.CONSULTANT,
        consultantProfile: {
          create: {
            description: formData.description,
            qualifications: formData.qualifications,
            specialization: formData.specialization,
            experience: formData.experience,
            scheduleType: formData.scheduleType || ScheduleType.WEEKLY,
            domain: { connect: { id: formData.domain.id } },
            subDomains: formData.subDomains?.length
              ? {
                  connect: formData.subDomains
                    .filter((sd) => sd.id !== undefined && sd.id !== null)
                    .map((sd) => ({ id: sd.id })),
                }
              : undefined,
            tags: formData.tags?.length
              ? {
                  connect: formData.tags
                    .filter((t) => t.id !== undefined && t.id !== null)
                    .map((t) => ({ id: t.id })),
                }
              : undefined,
            slotsOfAvailabilityWeekly: formData.weeklySlots?.length
              ? { create: formData.weeklySlots }
              : undefined,
            slotsOfAvailabilityCustom: formData.customSlots?.length
              ? {
                  create: formData.customSlots.map((slot) => ({
                    availabilityStartsAt: new Date(
                      slot.availabilityStartsAt,
                    ).toISOString(),
                    availabilityEndsAt: new Date(
                      slot.availabilityEndsAt,
                    ).toISOString(),
                  })),
                }
              : undefined,
            // New consultant fields
            headline: formData.headline,
            websiteUrl: formData.websiteUrl,
            twitterUrl: formData.twitterUrl,
            githubUrl: formData.githubUrl,
            videoIntroUrl: formData.videoIntroUrl,
            languages: formData.languages ?? [],
            toolsAndTechnologies: formData.toolsAndTechnologies ?? [],
            mentoringStyle: formData.mentoringStyle,
            sessionTypes: formData.sessionTypes ?? [],
          },
        },
        consulteeProfile: undefined,
        staffProfile: undefined,
      };

    case UserRole.CONSULTEE:
      return {
        ...baseData,
        role: UserRole.CONSULTEE,
        consultantProfile: undefined,
        consulteeProfile: {
          create: {
            education: formData.education,
            occupation: formData.occupation,
            aboutMe: formData.aboutMe,
            preferredCommunicationMethod:
              formData.preferredCommunicationMethod || ConsultationMode.VIDEO,
            preferredLanguage: formData.preferredLanguage,
            specialRequirements: formData.specialRequirements,
            interests: formData.interests,
            goals: formData.goals,
            // New consultee fields
            careerStage: formData.careerStage,
            currentCompany: formData.currentCompany,
            industry: formData.industry,
            skillsToDevelop: formData.skillsToDevelop ?? [],
            linkedinUrl: formData.linkedinUrl,
            budgetPreference: formData.budgetPreference,
          },
        },
        staffProfile: undefined,
      };

    case UserRole.STAFF:
      return {
        ...baseData,
        role: UserRole.STAFF,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: {
          create: {
            department: formData.department,
            position: formData.position,
            permissions: formData.permissions,
            responsibilities: formData.responsibilities,
            // New staff fields
            employeeId: formData.employeeId,
            hireDate: formData.hireDate,
            reportsTo: formData.reportsTo,
            skills: formData.skills ?? [],
            workSchedule: formData.workSchedule,
          },
        },
      };

    case UserRole.ADMIN:
      return {
        ...baseData,
        role: UserRole.ADMIN,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: undefined,
        // Admin profile is optional during onboarding
        ...(formData.adminLevel && {
          adminProfile: {
            create: {
              adminLevel: formData.adminLevel,
              accessScope: formData.accessScope,
              assignedRegions: formData.assignedRegions ?? [],
              notes: formData.adminNotes,
            },
          },
        }),
      };

    default:
      throw new Error(`Invalid role: ${formData.role}`);
  }
}

export function transformFrontendToServerData(
  frontendData: FrontendOnboardingData,
): OnboardingData {
  const baseData = {
    name: frontendData.name,
    email: frontendData.email,
    phone: frontendData.phone,
    address: frontendData.address,
    timezone: frontendData.timezone,
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
    // New fields
    headline: profile.headline,
    websiteUrl: profile.websiteUrl,
    twitterUrl: profile.twitterUrl,
    githubUrl: profile.githubUrl,
    videoIntroUrl: profile.videoIntroUrl,
    languages: profile.languages ?? [],
    toolsAndTechnologies: profile.toolsAndTechnologies ?? [],
    mentoringStyle: profile.mentoringStyle,
    sessionTypes: profile.sessionTypes ?? [],
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
    // New fields
    careerStage: profile.careerStage,
    currentCompany: profile.currentCompany,
    industry: profile.industry,
    skillsToDevelop: profile.skillsToDevelop ?? [],
    linkedinUrl: profile.linkedinUrl,
    budgetPreference: profile.budgetPreference,
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
    // New fields
    employeeId: profile.employeeId,
    hireDate: profile.hireDate,
    reportsTo: profile.reportsTo,
    skills: profile.skills ?? [],
    workSchedule: profile.workSchedule,
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

async function getExistingUserForValidation(id: string) {
  const { default: prisma } = await import("@/lib/prisma");
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
      const validWeeklySlots = weeklySlotsToCreate.filter((slot) =>
        isValidTimeRange(
          slot.availabilityStartsAt.split("T")[1]?.slice(0, 5) || "",
          slot.availabilityEndsAt.split("T")[1]?.slice(0, 5) || "",
        ),
      );
      if (validWeeklySlots.length > 0) {
        await tx.slotOfAvailabilityWeekly.createMany({
          data: validWeeklySlots.map((slot) => ({
            dayOfWeekForStartsAt: slot.dayOfWeekForStartsAt,
            availabilityStartsAt: slot.availabilityStartsAt,
            dayOfWeekForEndsAt: slot.dayOfWeekForEndsAt,
            availabilityEndsAt: slot.availabilityEndsAt,
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
      education: profileData.education ?? "",
      occupation: profileData.occupation ?? "",
      aboutMe: profileData.aboutMe ?? "",
      preferredCommunicationMethod: profileData.preferredCommunicationMethod,
      preferredLanguage: profileData.preferredLanguage ?? "",
      specialRequirements: profileData.specialRequirements ?? "",
      interests: interests,
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
      education: profileData.education ?? "",
      occupation: profileData.occupation ?? "",
      aboutMe: profileData.aboutMe ?? "",
      preferredCommunicationMethod: profileData.preferredCommunicationMethod,
      preferredLanguage: profileData.preferredLanguage ?? "",
      specialRequirements: profileData.specialRequirements ?? "",
      interests: interests,
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

// Central onboarding processing function
export async function processOnboardingData(
  userId: string,
  body: any,
): Promise<{ success: boolean; user?: any; error?: string }> {
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

    const { default: prisma } = await import("@/lib/prisma");

    const updatedUser = await prisma.$transaction(async (tx) => {
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
              workExperiences: true,
              certifications: true,
              education: true,
            },
          },
          consulteeProfile: {
            include: {
              educationHistory: true,
            },
          },
          staffProfile: true,
          adminProfile: true,
        },
      });
    });

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
