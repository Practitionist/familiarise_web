import { z } from "zod";
import {
  ScheduleType,
  UserRole,
  Gender,
  CareerStage,
  AdminLevel,
  BudgetPreference,
  SessionType,
  AchievementType,
} from "@prisma/client";
import { experienceValidation } from "@/schemas/shared";
import {
  WeeklySlotSchema,
  CustomSlotSchema,
  ConsultantProfileSchema,
  ConsulteeProfileSchema,
  StaffProfileSchema,
  AdminProfileSchema,
  WorkExperienceSchema,
  EducationSchema,
  CertificationSchema,
  CareerStageEnum,
} from "@/schemas/user";

// ============================================================================
// RE-EXPORTS — backward compat for consumers using old import paths
// ============================================================================

/** @deprecated Use WeeklySlotSchema from @/schemas/user */
export const SlotWeeklyCreateInputSchema = WeeklySlotSchema;
/** @deprecated Use CustomSlotSchema from @/schemas/user */
export const SlotCustomCreateInputSchema = CustomSlotSchema;

// ============================================================================
// SHARED FIELD SCHEMAS (defined once, reused everywhere)
// ============================================================================

export const AchievementCreateInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, "Achievement title is required"),
  description: z.string().optional(),
  url: z.string().url().or(z.literal("")).optional(),
  imageUrl: z.string().url().or(z.literal("")).optional(),
  achievementType: z
    .nativeEnum(AchievementType)
    .default(AchievementType.OTHER),
});

// Scalar consultant fields — picked from the single source of truth
const consultantScalarFields = ConsultantProfileSchema.pick({
  description: true,
  experience: true,
  headline: true,
  websiteUrl: true,
  twitterUrl: true,
  githubUrl: true,
  videoIntroUrl: true,
  languages: true,
  toolsAndTechnologies: true,
  mentoringStyle: true,
  sessionTypes: true,
  qualifications: true,
  specialization: true,
  scheduleType: true,
});

// Frontend-shaped relational fields (domain with name, arrays of objects)
const domainRefSchema = z.object({ id: z.string(), name: z.string() });
const subDomainRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  domainId: z.string(),
});
const tagRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  domainId: z.string(),
});

// Prisma-shaped relational fields (connect/set syntax)
const prismaRelationsSchema = z.object({
  domain: z.object({ connect: z.object({ id: z.string() }) }),
  subDomains: z
    .object({
      connect: z.array(z.object({ id: z.string() })).optional(),
      set: z.array(z.object({ id: z.string() })).optional(),
    })
    .optional(),
  tags: z
    .object({
      connect: z.array(z.object({ id: z.string() })).optional(),
      set: z.array(z.object({ id: z.string() })).optional(),
    })
    .optional(),
  slotsOfAvailabilityWeekly: z
    .object({ create: z.array(WeeklySlotSchema).optional() })
    .optional(),
  slotsOfAvailabilityCustom: z
    .object({ create: z.array(CustomSlotSchema).optional() })
    .optional(),
});

// ============================================================================
// SERVER INPUT SCHEMAS (Prisma-shaped, used by server processing)
// ============================================================================

export const BaseConsultantProfileCreateInputSchema = consultantScalarFields
  .merge(prismaRelationsSchema);

export const ConsultantProfileCreateObjectSchema = z.object({
  create: BaseConsultantProfileCreateInputSchema,
});

export const BaseConsulteeProfileCreateInputSchema = ConsulteeProfileSchema;

export const ConsulteeProfileCreateObjectSchema = z.object({
  create: BaseConsulteeProfileCreateInputSchema,
});

export const BaseStaffProfileCreateInputSchema = StaffProfileSchema;

export const StaffProfileCreateObjectSchema = z.object({
  create: BaseStaffProfileCreateInputSchema,
});

export const BaseAdminProfileCreateInputSchema = AdminProfileSchema.extend({
  accessScope: z.any().optional().nullable(),
});

export const AdminProfileCreateObjectSchema = z.object({
  create: BaseAdminProfileCreateInputSchema,
});

// ============================================================================
// SERVER PAYLOAD SCHEMA (what the API receives)
// ============================================================================

export const OnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  timezone: z.string().optional(),
  onlineStatus: z.boolean().optional().default(false),
  onboardingCompleted: z.boolean().optional().default(false),
  dateOfBirth: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(160).optional(),
  verificationLinkedinUrl: z.string().optional(),
  verificationNotes: z.string().optional(),
  verificationDocuments: z.array(z.any()).optional(),
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

// ============================================================================
// FRONTEND SCHEMAS (flat structure for forms and client-side code)
// ============================================================================

export const FrontendConsultantProfileSchema = consultantScalarFields.extend({
  domain: domainRefSchema,
  subDomains: z.array(subDomainRefSchema).optional(),
  tags: z.array(tagRefSchema).optional(),
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),
});

export const FrontendConsulteeProfileSchema = ConsulteeProfileSchema;

export const FrontendStaffProfileSchema = StaffProfileSchema;

export const FrontendAdminProfileSchema = AdminProfileSchema;

export const FrontendOnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  timezone: z.string().optional(),
  onlineStatus: z.boolean().default(false),
  onboardingCompleted: z.boolean().default(false),
  role: z.nativeEnum(UserRole),
  dateOfBirth: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(160).optional(),
});

// ============================================================================
// FORM SCHEMAS (react-hook-form compatible, with stricter validation)
// ============================================================================

export const PersonalInfoAndRoleFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  role: z.nativeEnum(UserRole),
  onlineStatus: z.boolean().optional(),
  onboardingCompleted: z.boolean().optional(),
  dateOfBirth: z.coerce.date().optional().nullable(),
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal("")),
  bio: z.string().max(160).optional(),
});

// Consultant form: scalar fields from source + frontend relational fields + stricter description
export const ConsultantProfileFormSchema = consultantScalarFields
  .extend({
    description: z.string().min(1, "Description is required"),
    domain: domainRefSchema,
    subDomains: z.array(subDomainRefSchema).optional(),
    tags: z.array(tagRefSchema).optional(),
    weeklySlots: z.array(WeeklySlotSchema).optional(),
    customSlots: z.array(CustomSlotSchema).optional(),
  });

// Consultee form: derived from base with stricter validation
export const ConsulteeProfileFormSchema = ConsulteeProfileSchema.extend({
  careerStage: CareerStageEnum,
  aboutMe: z.string().optional(),
  skillsToDevelop: z.array(z.string()).optional(),
  // Inline education for STUDENT path
  consulteeInlineEducation: z
    .object({
      institution: z.string().optional(),
      institutionDomain: z.string().optional(),
      fieldOfStudy: z.string().optional(),
      endYear: z.number().min(1900).max(2100).optional(),
    })
    .optional(),
  // Inline work experience for PROFESSIONAL path
  consulteeInlineWorkExperience: z
    .object({
      title: z.string().optional(),
      company: z.string().optional(),
      companyDomain: z.string().optional(),
    })
    .optional(),
});

// Staff form: derived from base with stricter validation
export const StaffProfileFormSchema = StaffProfileSchema.extend({
  department: z.string().min(1, "Department is required"),
  position: z.string().min(1, "Position is required"),
  responsibilities: z.record(z.boolean()).optional(),
});

export const AdminProfileFormSchema = AdminProfileSchema;

export const PreferredScheduleFormSchema = z.object({
  scheduleType: z.nativeEnum(ScheduleType),
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),
});

// ============================================================================
// ROLE-SPECIFIC ONBOARDING FORM SCHEMAS (replaces the mega-schema)
// ============================================================================

const sharedFormFields = PersonalInfoAndRoleFormSchema.extend({
  timezone: z.string().optional(),
  onlineStatus: z.boolean().default(false),
  onboardingCompleted: z.boolean().default(false),
  emailVerified: z.date().optional(),
  image: z.string().optional(),
  termsAccepted: z.boolean().optional(),
  privacyAccepted: z.boolean().optional(),
});

const consultantFormFields = sharedFormFields.extend({
  role: z.literal(UserRole.CONSULTANT),
  // Consultant profile fields (from single source)
  ...consultantScalarFields.shape,
  description: z.string().optional(),
  experience: experienceValidation.optional(),
  scheduleType: z.nativeEnum(ScheduleType).optional(),
  // Frontend-shaped relations
  // domain is optional in step-state (progressive form fill) but required at
  // submission time — OnboardingDataSchema (server payload) enforces this via
  // ConsultantProfileCreateObjectSchema which requires domain.connect.id.
  domain: domainRefSchema.optional(),
  subDomains: z.array(subDomainRefSchema).optional(),
  tags: z.array(tagRefSchema).optional(),
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),
  // Make array defaults optional for form state
  languages: z.array(z.string()).optional(),
  toolsAndTechnologies: z.array(z.string()).optional(),
  sessionTypes: z.array(z.nativeEnum(SessionType)).optional(),
  // Verification
  verificationLinkedinUrl: z.string().url().optional().or(z.literal("")),
  verificationNotes: z.string().max(500).optional(),
  verificationDocuments: z.array(z.any()).optional(),
  // Professional background
  workExperiences: z.array(WorkExperienceSchema).optional(),
  achievements: z.array(AchievementCreateInputSchema).optional(),
  educationHistory: z.array(EducationSchema).optional(),
  certificationsList: z.array(CertificationSchema).optional(),
});

const consulteeFormFields = sharedFormFields.extend({
  role: z.literal(UserRole.CONSULTEE),
  ...ConsulteeProfileSchema.shape,
  // Inline education for STUDENT path
  consulteeInlineEducation: z
    .object({
      institution: z.string().optional(),
      institutionDomain: z.string().optional(),
      fieldOfStudy: z.string().optional(),
      endYear: z.number().min(1900).max(2100).optional(),
    })
    .optional(),
  // Inline work experience for PROFESSIONAL path
  consulteeInlineWorkExperience: z
    .object({
      title: z.string().optional(),
      company: z.string().optional(),
      companyDomain: z.string().optional(),
    })
    .optional(),
});

const staffFormFields = sharedFormFields.extend({
  role: z.literal(UserRole.STAFF),
  ...StaffProfileSchema.shape,
  permissions: z.record(z.boolean()).optional(),
  responsibilities: z.record(z.boolean()).optional(),
  skills: z.array(z.string()).optional(),
});

const adminFormFields = sharedFormFields.extend({
  role: z.literal(UserRole.ADMIN),
  adminLevel: z.nativeEnum(AdminLevel).optional(),
  accessScope: z.any().optional().nullable(),
  assignedRegions: z.array(z.string()).optional(),
  adminNotes: z.string().optional(),
});

// Combined mega-schema: discriminated union on role to prevent
// z.union from matching the wrong schema and stripping role-specific fields
export const OnboardingFormDataSchema = z.discriminatedUnion("role", [
  consultantFormFields,
  consulteeFormFields,
  staffFormFields,
  adminFormFields,
]);

// ============================================================================
// TYPES
// ============================================================================

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

// OnboardingFormData — flat type with all possible fields (for page-level form state).
// Individual steps use role-specific schemas for stricter validation.
// Omit `role` from each branch before intersecting, then add it back as UserRole,
// because the literal role types ("CONSULTANT" & "CONSULTEE" & ...) would collapse to `never`.
export type OnboardingFormData = Omit<
  z.infer<typeof consultantFormFields>,
  "role"
> &
  Partial<Omit<z.infer<typeof consulteeFormFields>, "role">> &
  Partial<Omit<z.infer<typeof staffFormFields>, "role">> &
  Partial<Omit<z.infer<typeof adminFormFields>, "role">> & {
    role: UserRole;
  };

// ============================================================================
// TRANSFORM: Form Data → Server Payload
// ============================================================================

/** Extract user-level fields from form data */
function pickUserFields(formData: OnboardingFormData) {
  return {
    name: formData.name,
    email: formData.email,
    phone: formData.phone,
    address: formData.address,
    timezone:
      formData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    onlineStatus: formData.onlineStatus || false,
    onboardingCompleted: true,
    role: formData.role,
    dateOfBirth: formData.dateOfBirth,
    gender: formData.gender,
    city: formData.city,
    country: formData.country,
    linkedinUrl: formData.linkedinUrl,
    bio: formData.bio,
    verificationLinkedinUrl: formData.verificationLinkedinUrl,
    verificationNotes: formData.verificationNotes,
    verificationDocuments: formData.verificationDocuments,
  };
}

/** Transform frontend domain/relations to Prisma connect syntax */
function buildConsultantServerProfile(formData: OnboardingFormData) {
  if (!formData.domain?.id) {
    throw new Error("Domain is required for consultant profile");
  }
  return {
    description: formData.description,
    headline: formData.headline,
    experience: formData.experience,
    scheduleType: formData.scheduleType || ScheduleType.WEEKLY,
    domain: { connect: { id: formData.domain.id } },
    subDomains: formData.subDomains?.length
      ? {
          connect: formData.subDomains
            .filter((sd) => sd.id != null)
            .map((sd) => ({ id: sd.id })),
        }
      : undefined,
    tags: formData.tags?.length
      ? {
          connect: formData.tags
            .filter((t) => t.id != null)
            .map((t) => ({ id: t.id })),
        }
      : undefined,
    slotsOfAvailabilityWeekly: formData.weeklySlots?.length
      ? { create: formData.weeklySlots }
      : undefined,
    slotsOfAvailabilityCustom: formData.customSlots?.length
      ? {
          create: formData.customSlots.map((slot) => ({
            startsAt: new Date(slot.startsAt).toISOString(),
            endsAt: new Date(slot.endsAt).toISOString(),
          })),
        }
      : undefined,
    websiteUrl: formData.websiteUrl,
    twitterUrl: formData.twitterUrl,
    githubUrl: formData.githubUrl,
    videoIntroUrl: formData.videoIntroUrl,
    languages: formData.languages ?? [],
    toolsAndTechnologies: formData.toolsAndTechnologies ?? [],
    mentoringStyle: formData.mentoringStyle,
    sessionTypes: formData.sessionTypes ?? [],
  };
}

export function transformOnboardingFormToServerData(
  formData: OnboardingFormData,
): OnboardingData {
  const base = pickUserFields(formData);

  switch (formData.role) {
    case UserRole.CONSULTANT:
      return {
        ...base,
        role: UserRole.CONSULTANT,
        consultantProfile: { create: buildConsultantServerProfile(formData) },
        consulteeProfile: undefined,
        staffProfile: undefined,
      };

    case UserRole.CONSULTEE: {
      // Build inline education/work experience arrays for persistProfessionalBackground
      const inlineEdu = formData.consulteeInlineEducation;
      const inlineWork = formData.consulteeInlineWorkExperience;

      const payload: OnboardingData & Record<string, unknown> = {
        ...base,
        role: UserRole.CONSULTEE,
        consultantProfile: undefined,
        consulteeProfile: {
          create: {
            aboutMe: formData.aboutMe,
            preferredLanguage: formData.preferredLanguage,
            goals: formData.goals,
            careerStage: formData.careerStage,
            skillsToDevelop: formData.skillsToDevelop ?? [],
            budgetPreference: formData.budgetPreference,
          },
        },
        staffProfile: undefined,
      };

      // STUDENT path: inline education → educationHistory array
      if (
        formData.careerStage === CareerStage.STUDENT &&
        inlineEdu?.institution
      ) {
        payload.educationHistory = [
          {
            institution: inlineEdu.institution,
            institutionDomain: inlineEdu.institutionDomain,
            degree: "Student",
            fieldOfStudy: inlineEdu.fieldOfStudy,
            endYear: inlineEdu.endYear,
          },
        ];
      }

      // PROFESSIONAL path: inline work experience → workExperiences array
      if (
        formData.careerStage &&
        formData.careerStage !== CareerStage.STUDENT &&
        formData.careerStage !== CareerStage.SCHOOL_STUDENT &&
        inlineWork?.company
      ) {
        payload.workExperiences = [
          {
            company: inlineWork.company,
            companyDomain: inlineWork.companyDomain,
            title: inlineWork.title || "Professional",
            isCurrent: true,
            startDate: new Date(),
          },
        ];
      }

      return payload;
    }

    case UserRole.STAFF:
      return {
        ...base,
        role: UserRole.STAFF,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: {
          create: {
            department: formData.department,
            position: formData.position,
            permissions: formData.permissions,
            responsibilities: formData.responsibilities,
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
        ...base,
        role: UserRole.ADMIN,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: undefined,
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
  const base = {
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
    case UserRole.CONSULTANT: {
      const p = frontendData.consultantProfile;
      if (!p) throw new Error("Consultant profile is required");
      return {
        ...base,
        role: UserRole.CONSULTANT,
        consultantProfile: {
          create: {
            description: p.description,
            headline: p.headline,
            experience: p.experience,
            scheduleType: p.scheduleType,
            domain: { connect: { id: p.domain.id } },
            subDomains: p.subDomains?.length
              ? { connect: p.subDomains.map((s) => ({ id: s.id })) }
              : undefined,
            tags: p.tags?.length
              ? { connect: p.tags.map((t) => ({ id: t.id })) }
              : undefined,
            slotsOfAvailabilityWeekly: p.weeklySlots?.length
              ? { create: p.weeklySlots }
              : undefined,
            slotsOfAvailabilityCustom: p.customSlots?.length
              ? { create: p.customSlots }
              : undefined,
            websiteUrl: p.websiteUrl,
            twitterUrl: p.twitterUrl,
            githubUrl: p.githubUrl,
            videoIntroUrl: p.videoIntroUrl,
            languages: p.languages ?? [],
            toolsAndTechnologies: p.toolsAndTechnologies ?? [],
            mentoringStyle: p.mentoringStyle,
            sessionTypes: p.sessionTypes ?? [],
          },
        },
        consulteeProfile: undefined,
        staffProfile: undefined,
      };
    }

    case UserRole.CONSULTEE: {
      const p = frontendData.consulteeProfile;
      if (!p) throw new Error("Consultee profile is required");
      return {
        ...base,
        role: UserRole.CONSULTEE,
        consultantProfile: undefined,
        consulteeProfile: {
          create: {
            aboutMe: p.aboutMe,
            preferredLanguage: p.preferredLanguage,
            goals: p.goals,
            careerStage: p.careerStage,
            skillsToDevelop: p.skillsToDevelop ?? [],
            budgetPreference: p.budgetPreference,
          },
        },
        staffProfile: undefined,
      };
    }

    case UserRole.STAFF: {
      const p = frontendData.staffProfile;
      if (!p) throw new Error("Staff profile is required");
      return {
        ...base,
        role: UserRole.STAFF,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: {
          create: {
            department: p.department,
            position: p.position,
            permissions: p.permissions,
            responsibilities: p.responsibilities,
            employeeId: p.employeeId,
            hireDate: p.hireDate,
            reportsTo: p.reportsTo,
            skills: p.skills ?? [],
            workSchedule: p.workSchedule,
          },
        },
      };
    }

    case UserRole.ADMIN:
      return {
        ...base,
        role: UserRole.ADMIN,
        consultantProfile: undefined,
        consulteeProfile: undefined,
        staffProfile: undefined,
      };

    default:
      throw new Error(`Invalid role: ${frontendData.role}`);
  }
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

export function validateOnboardingData(
  data: unknown,
):
  | { success: true; data: OnboardingData }
  | { success: false; error: string } {
  const validationResult = OnboardingDataSchema.safeParse(data);

  if (!validationResult.success) {
    const errorMessage = validationResult.error.errors
      .map((e) => `Field '${e.path.join(".")}': ${e.message}`)
      .join("; ");
    return { success: false, error: `Invalid input: ${errorMessage}` };
  }

  return { success: true, data: validationResult.data };
}

export function validateFrontendOnboardingData(
  data: unknown,
):
  | { success: true; data: FrontendOnboardingData }
  | { success: false; error: string } {
  try {
    const record = data as Record<string, unknown>;
    if (!record.name || !record.email || !record.role) {
      return {
        success: false,
        error: "Missing required fields: name, email, or role",
      };
    }

    switch (record.role) {
      case UserRole.CONSULTANT: {
        const cp = record.consultantProfile as
          | { domain?: { id?: string } }
          | undefined;
        if (!cp) {
          return { success: false, error: "Consultant profile is required" };
        }
        if (!cp.domain?.id) {
          return {
            success: false,
            error: "Domain is required for consultant profile",
          };
        }
        break;
      }
      case UserRole.CONSULTEE:
        if (!record.consulteeProfile) {
          return { success: false, error: "Consultee profile is required" };
        }
        break;
      case UserRole.STAFF:
        if (!record.staffProfile) {
          return { success: false, error: "Staff profile is required" };
        }
        break;
    }

    return { success: true, data: record as FrontendOnboardingData };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Validation failed",
    };
  }
}
