import { z } from "zod";
import {
  ConsultationMode,
  ScheduleType,
  UserRole,
  DayOfWeek,
  Gender,
  CareerStage,
  AdminLevel,
  BudgetPreference,
  SessionType,
} from "@prisma/client";
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

  // Verification fields (for consultants)
  verificationLinkedinUrl: z.string().url().optional().or(z.literal("")),
  verificationNotes: z.string().max(500).optional(),
  verificationDocuments: z.array(z.any()).optional(),

  // Professional background fields (for consultants)
  workExperiences: z
    .array(
      z.object({
        id: z.string().optional(),
        company: z.string(),
        title: z.string(),
        location: z.string().optional(),
        startDate: z.coerce.date(),
        endDate: z.coerce.date().optional(),
        isCurrent: z.boolean(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  educationHistory: z
    .array(
      z.object({
        id: z.string().optional(),
        institution: z.string(),
        degree: z.string(),
        fieldOfStudy: z.string().optional(),
        startYear: z.number().optional().nullable(),
        endYear: z.number().optional().nullable(),
        grade: z.string().optional(),
        activities: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  certificationsList: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        issuingOrganization: z.string(),
        issueDate: z.coerce.date(),
        expiryDate: z.coerce.date().optional(),
        credentialId: z.string().optional(),
        credentialUrl: z.string().optional(),
      }),
    )
    .optional(),
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

// Note: Database operations have been moved to utils/onboarding-server.ts
// Import processOnboardingData from there for server-side usage
