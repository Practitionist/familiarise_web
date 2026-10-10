import { z } from "zod";
import {
  ScheduleType,
  UserRole,
  Gender,
  OfferingFormat,
  AchievementType,
} from "@prisma/client";
import { experienceValidation } from "@/schemas/shared";
import { DateOfBirthSchema } from "@/lib/compliance/age";
import { MAX_OUTSTANDING_UPLOADS } from "@/lib/verification/documents";
import {
  WeeklySlotSchema,
  CustomSlotSchema,
  ConsultantProfileSchema,
  ConsulteeProfileSchema,
  WorkExperienceSchema,
  EducationSchema,
  CertificationSchema,
  LONG_FORM_TEXT_MAX,
  linkedinProfileUrlFormSchema,
} from "@/schemas/user";

// ============================================================================
// SHARED FIELD SCHEMAS (defined once, reused everywhere)
// ============================================================================

export const AchievementCreateInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, "Achievement title is required"),
  // Capped like the other pasteable free-text fields — see the note on
  // LONG_FORM_TEXT_MAX in schemas/user.ts.
  description: z
    .string()
    .max(
      LONG_FORM_TEXT_MAX,
      `Description must be ${LONG_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
  url: z.string().url().or(z.literal("")).optional(),
  imageUrl: z.string().url().or(z.literal("")).optional(),
  achievementType: z.nativeEnum(AchievementType).default(AchievementType.OTHER),
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
  offeringFormats: true,
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
  availabilityWindowsWeekly: z
    .object({ create: z.array(WeeklySlotSchema).optional() })
    .optional(),
  availabilityWindowsCustom: z
    .object({ create: z.array(CustomSlotSchema).optional() })
    .optional(),
});

// ============================================================================
// SERVER INPUT SCHEMAS (Prisma-shaped, used by server processing)
// ============================================================================

export const BaseConsultantProfileCreateInputSchema =
  consultantScalarFields.merge(prismaRelationsSchema);

// The wizard's "at least one window" rule lived only in the client; the
// server now refuses a CONSULTANT payload whose chosen schedule type carries no
// windows (the same rule the settings PUT and lib/scheduling/availability-contract
// enforce), so a direct caller cannot onboard an unbookable consultant.
export const ConsultantProfileCreateObjectSchema = z.object({
  create: BaseConsultantProfileCreateInputSchema.superRefine((data, ctx) => {
    const weekly = data.availabilityWindowsWeekly?.create?.length ?? 0;
    const custom = data.availabilityWindowsCustom?.create?.length ?? 0;
    const count = data.scheduleType === ScheduleType.CUSTOM ? custom : weekly;
    if (count === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one availability window for the chosen schedule",
        path: [
          data.scheduleType === ScheduleType.CUSTOM
            ? "availabilityWindowsCustom"
            : "availabilityWindowsWeekly",
        ],
      });
    }
  }),
});

export const BaseConsulteeProfileCreateInputSchema = ConsulteeProfileSchema;

export const ConsulteeProfileCreateObjectSchema = z.object({
  create: BaseConsulteeProfileCreateInputSchema,
});

// ============================================================================
// SERVER PAYLOAD SCHEMA (what the API receives)
// ============================================================================

// #region Verification References

/**
 * A client-supplied reference to one uploaded verification document.
 *
 * Only `id` is meaningful. Everything else exists so the form can render a row
 * for a document it already has, and **none of it is persisted** — the server
 * writes only `id`, and `lib/verification/submit-request.ts` re-reads every row
 * it links with `uploadedByUserId` scoping and a count assertion. A client that
 * invents a `fileUrl` here changes nothing but its own rendering.
 *
 * This was `z.array(z.any())`, which is not a safety valve but a false claim:
 * `safeParse` could never raise a field error for a malformed array, so the form
 * failed silently, and the array itself was unbounded (#1869).
 */
export const VerificationDocumentRefSchema = z
  .object({
    id: z.string().min(1),
    /** Draft rows carry no server id and are dropped, not persisted. */
    isOnboardingUpload: z.boolean().optional(),
    fileName: z.string().max(255).optional(),
    originalName: z.string().max(255).optional(),
    fileSize: z.number().int().nonnegative().optional(),
    mimeType: z.string().max(100).optional(),
    fileUrl: z.string().max(2048).optional(),
    storagePath: z.string().max(1024).optional(),
    description: z.string().max(500).optional(),
  })
  .strip();

/** One document limit for the wizard, the submit payload and the upload route. */
export const MAX_VERIFICATION_DOCUMENTS = MAX_OUTSTANDING_UPLOADS;

/** Admin-facing free text on a verification submission. */
export const VERIFICATION_NOTES_MAX = 500;

const VerificationDocumentsSchema = z
  .array(VerificationDocumentRefSchema)
  .max(
    MAX_VERIFICATION_DOCUMENTS,
    `You can attach at most ${MAX_VERIFICATION_DOCUMENTS} documents`,
  )
  .optional();

// #endregion

export const OnboardingBaseSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: z.string().optional(),
  address: z.string().optional(),
  timezone: z.string().optional(),
  onlineStatus: z.boolean().optional().default(false),
  onboardingCompleted: z.boolean().optional().default(false),
  dateOfBirth: DateOfBirthSchema,
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: linkedinProfileUrlFormSchema,
  bio: z.string().max(160).optional(),
  verificationLinkedinUrl: linkedinProfileUrlFormSchema,
  verificationNotes: z.string().max(VERIFICATION_NOTES_MAX).optional(),
  verificationDocuments: VerificationDocumentsSchema,
});

/**
 * Consent on every completion path. The browser sends only the two literals;
 * the server stamps the timestamps and `TERMS_VERSION`.
 */
export const OnboardingConsentSchema = z.object({
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: "Accept the terms of service to continue" }),
  }),
  privacyAccepted: z.literal(true, {
    errorMap: () => ({ message: "Accept the privacy policy to continue" }),
  }),
  marketingConsent: z.boolean().optional(),
});

export type OnboardingConsent = z.infer<typeof OnboardingConsentSchema>;

/** The interstitial for invitees and SSO members: an 18+ DOB plus consent. */
export const OnboardingGateSchema = OnboardingConsentSchema.extend({
  dateOfBirth: DateOfBirthSchema,
});

export type OnboardingGateInput = z.infer<typeof OnboardingGateSchema>;

const OnboardingSubmitBaseSchema = OnboardingBaseSchema.merge(
  OnboardingConsentSchema,
);

export const OnboardingDataSchema = z.discriminatedUnion("role", [
  OnboardingSubmitBaseSchema.extend({
    role: z.literal(UserRole.CONSULTANT),
    consultantProfile: ConsultantProfileCreateObjectSchema,
    consulteeProfile: z.undefined().optional(),
  }),
  OnboardingSubmitBaseSchema.extend({
    role: z.literal(UserRole.CONSULTEE),
    consultantProfile: z.undefined().optional(),
    consulteeProfile: ConsulteeProfileCreateObjectSchema,
  }),
]);

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
  dateOfBirth: DateOfBirthSchema,
  gender: z.nativeEnum(Gender).optional().nullable(),
  city: z.string().optional(),
  country: z.string().optional(),
  linkedinUrl: linkedinProfileUrlFormSchema,
  bio: z.string().max(160).optional(),
});

// Consultant form: scalar fields from source + frontend relational fields + stricter description
export const ConsultantProfileFormSchema = consultantScalarFields.extend({
  // Re-stated to add the required-ness, so the cap inherited from
  // ConsultantProfileSchema has to be re-stated with it.
  description: z
    .string()
    .min(1, "Description is required")
    .max(
      LONG_FORM_TEXT_MAX,
      `Description must be ${LONG_FORM_TEXT_MAX} characters or less`,
    ),
  domain: domainRefSchema,
  subDomains: z.array(subDomainRefSchema).optional(),
  tags: z.array(tagRefSchema).optional(),
  weeklySlots: z.array(WeeklySlotSchema).optional(),
  customSlots: z.array(CustomSlotSchema).optional(),
});

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
  marketingConsent: z.boolean().optional(),
});

const consultantFormFields = sharedFormFields.extend({
  role: z.literal(UserRole.CONSULTANT),
  // Consultant profile fields (from single source)
  ...consultantScalarFields.shape,
  // Loosened to optional for progressive step state; the cap still applies.
  description: z
    .string()
    .max(
      LONG_FORM_TEXT_MAX,
      `Description must be ${LONG_FORM_TEXT_MAX} characters or less`,
    )
    .optional(),
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
  offeringFormats: z.array(z.nativeEnum(OfferingFormat)).optional(),
  // Verification
  verificationLinkedinUrl: linkedinProfileUrlFormSchema,
  verificationNotes: z.string().max(VERIFICATION_NOTES_MAX).optional(),
  verificationDocuments: VerificationDocumentsSchema,
  // Professional background
  workExperiences: z.array(WorkExperienceSchema).optional(),
  achievements: z.array(AchievementCreateInputSchema).optional(),
  educationHistory: z.array(EducationSchema).optional(),
  certificationsList: z.array(CertificationSchema).optional(),
});

const consulteeFormFields = sharedFormFields.extend({
  role: z.literal(UserRole.CONSULTEE),
  ...ConsulteeProfileSchema.shape,
});

// ORG_WORKSPACE collects personal info + agreement here; the create-org
// wizard then completes onboarding inside `POST /api/organizations`.
const orgWorkspaceFormFields = sharedFormFields.extend({
  role: z.literal("ORG_WORKSPACE" as const),
});

// Combined mega-schema: discriminated union on role to prevent
// z.union from matching the wrong schema and stripping role-specific fields
export const OnboardingFormDataSchema = z.discriminatedUnion("role", [
  consultantFormFields,
  consulteeFormFields,
  orgWorkspaceFormFields,
]);

// ============================================================================
// TYPES
// ============================================================================

export type OnboardingData = z.infer<typeof OnboardingDataSchema>;
type WithConsentBooleans<T> = T extends unknown
  ? Omit<T, "termsAccepted" | "privacyAccepted"> & {
      termsAccepted: boolean;
      privacyAccepted: boolean;
    }
  : never;
/** The wire payload the wizard sends: consent is a boolean the server checks. */
export type OnboardingSubmitPayload = WithConsentBooleans<OnboardingData>;
export type ConsultantProfileCreateData = z.infer<
  typeof BaseConsultantProfileCreateInputSchema
>;
export type ConsulteeProfileCreateData = z.infer<
  typeof BaseConsulteeProfileCreateInputSchema
>;

// OnboardingFormData — flat type with all possible fields (for page-level form state).
// Individual steps use role-specific schemas for stricter validation.
// Omit `role` from each branch before intersecting, then add it back as UserRole,
// because the literal role types ("CONSULTANT" & "CONSULTEE" & ...) would collapse to `never`.
export type OnboardingFormData = Omit<
  z.infer<typeof consultantFormFields>,
  "role"
> &
  Partial<Omit<z.infer<typeof consulteeFormFields>, "role">> &
  Partial<Omit<z.infer<typeof orgWorkspaceFormFields>, "role">> & {
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
    // Wrong values are refused by OnboardingConsentSchema on the server.
    termsAccepted: formData.termsAccepted === true,
    privacyAccepted: formData.privacyAccepted === true,
    marketingConsent: formData.marketingConsent === true,
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
    availabilityWindowsWeekly: formData.weeklySlots?.length
      ? { create: formData.weeklySlots }
      : undefined,
    availabilityWindowsCustom: formData.customSlots?.length
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
    offeringFormats: formData.offeringFormats ?? [],
  };
}

export function transformOnboardingFormToServerData(
  formData: OnboardingFormData,
): OnboardingSubmitPayload {
  const base = pickUserFields(formData);

  switch (formData.role) {
    case UserRole.CONSULTANT:
      return {
        ...base,
        role: UserRole.CONSULTANT,
        consultantProfile: { create: buildConsultantServerProfile(formData) },
        consulteeProfile: undefined,
      };

    case UserRole.CONSULTEE:
      return {
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
      };

    default:
      throw new Error(`Invalid role: ${formData.role}`);
  }
}

/**
 * The onboarding half of `POST /api/organizations` for a first-time owner:
 * the gate fields plus the step-0 identity columns, applied in the org tx.
 */
export const OrgOnboardingSchema = OnboardingGateSchema.extend({
  name: z.string().trim().min(1, "Name is required").max(200),
  phone: z.string().trim().min(1).max(50).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
}).strict();

export type OrgOnboardingInput = z.infer<typeof OrgOnboardingSchema>;

/** Wizard state → the `onboarding` block of the org-create body. */
export function transformOrgOnboardingForm(
  formData: Partial<OnboardingFormData>,
): Record<string, unknown> {
  return {
    name: formData.name?.trim() ?? "",
    // Blank inputs are omitted: `User.phone` is unique, so "" would collide.
    ...(formData.phone?.trim() ? { phone: formData.phone.trim() } : {}),
    ...(formData.timezone?.trim()
      ? { timezone: formData.timezone.trim() }
      : {}),
    dateOfBirth: formData.dateOfBirth,
    termsAccepted: formData.termsAccepted === true,
    privacyAccepted: formData.privacyAccepted === true,
    marketingConsent: formData.marketingConsent === true,
  };
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

export function validateOnboardingData(data: unknown):
  | { success: true; data: OnboardingData }
  | {
      success: false;
      error: string;
      /** The raw issues, so the caller can route the first one to its field. */
      issues: { path: (string | number)[]; message: string }[];
    } {
  const validationResult = OnboardingDataSchema.safeParse(data);

  if (!validationResult.success) {
    const errorMessage = validationResult.error.errors
      .map((e) => `Field '${e.path.join(".")}': ${e.message}`)
      .join("; ");
    return {
      success: false,
      error: `Invalid input: ${errorMessage}`,
      issues: validationResult.error.errors.map((e) => ({
        path: e.path,
        message: e.message,
      })),
    };
  }

  return { success: true, data: validationResult.data };
}
