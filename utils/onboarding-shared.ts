import { z } from "zod";
import type {
  ConsultantProfileCreateData,
  ConsulteeProfileCreateData,
} from "./onboarding";
import type { OnboardingData } from "./onboarding";
import {
  WorkExperienceSchema,
  EducationSchema,
  CertificationSchema,
} from "@/schemas/user";
import { AchievementCreateInputSchema } from "./onboarding";
import { stepKeyForField } from "@/app/form/onboarding/field-map";

// ============================================================================
// USER FIELD EXTRACTION
// ============================================================================

/** Extract user-level fields from validated onboarding data for Prisma update */
export function buildUserUpdateData(data: OnboardingData) {
  return {
    name: data.name,
    email: data.email,
    phone: data.phone || null,
    address: data.address,
    role: data.role,
    onboardingCompleted: true,
    timezone: data.timezone,
    dateOfBirth: data.dateOfBirth ?? null,
    gender: data.gender ?? null,
    city: data.city ?? null,
    country: data.country ?? null,
    linkedinUrl: data.linkedinUrl || null,
    bio: data.bio ?? null,
  };
}

// ============================================================================
// PROFILE DATA BUILDERS (shared between create & update)
// ============================================================================

/** Build the scalar (non-relational) data for a consultant profile upsert */
export function buildConsultantScalarData(data: ConsultantProfileCreateData) {
  return {
    description: data.description ?? "",
    experience: data.experience ?? null,
    scheduleType: data.scheduleType,
    headline: data.headline ?? null,
    websiteUrl: data.websiteUrl || null,
    twitterUrl: data.twitterUrl || null,
    githubUrl: data.githubUrl || null,
    videoIntroUrl: data.videoIntroUrl || null,
    languages: data.languages ?? [],
    toolsAndTechnologies: data.toolsAndTechnologies ?? [],
    mentoringStyle: data.mentoringStyle ?? null,
    offeringFormats: data.offeringFormats ?? [],
  };
}

/** Build the scalar data for a consultee profile upsert */
export function buildConsulteeScalarData(data: ConsulteeProfileCreateData) {
  // Defensive: goals is typed as string after Zod validation, but older clients
  // may send string[] — the Array.isArray guard handles that safely at runtime.
  const goals = Array.isArray(data.goals)
    ? (data.goals as string[]).join(", ")
    : (data.goals ?? "");

  return {
    aboutMe: data.aboutMe ?? "",
    preferredLanguage: data.preferredLanguage ?? "",
    goals,
    careerStage: data.careerStage ?? null,
    skillsToDevelop: data.skillsToDevelop ?? [],
    budgetPreference: data.budgetPreference ?? null,
  };
}

// ============================================================================
// VERIFICATION POLICY (pure)
// ============================================================================

/** Minimal shape of the verification-related fields on an onboarding body.
 *  Structural typing keeps this importable from both the server pipeline and
 *  tests without touching the "server-only" module graph. */
export interface VerificationSignals {
  verificationLinkedinUrl?: string;
  verificationDocuments?: unknown[];
}

/**
 * A refusal the wizard can act on: `code` is the server's machine word,
 * `field` the top-level payload field it is about (see
 * app/form/onboarding/field-map.ts), so the shell can open the owning step.
 */
export class OnboardingRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly index?: number,
  ) {
    super(message);
    this.name = "OnboardingRefusedError";
  }
}

/**
 * The server payload nests the profile (`consultantProfile.create.…`) and
 * names two fields differently from the wizard; a schema issue is routed to
 * the wizard's field by the first segment of its path that the wizard knows.
 */
const SERVER_FIELD_TO_WIZARD: Record<string, string> = {
  availabilityWindowsWeekly: "weeklySlots",
  availabilityWindowsCustom: "customSlots",
};

export function refusalFromIssues(
  issues: readonly { path: readonly (string | number)[]; message: string }[],
  fallbackMessage: string,
): OnboardingRefusedError {
  for (const issue of issues) {
    for (const segment of issue.path) {
      if (typeof segment !== "string") continue;
      const field = SERVER_FIELD_TO_WIZARD[segment] ?? segment;
      if (stepKeyForField(field) !== null) {
        return new OnboardingRefusedError("VALIDATION", issue.message, field);
      }
    }
  }
  return new OnboardingRefusedError("VALIDATION", fallbackMessage);
}

/** The `{ success: false }` arm every onboarding action returns. */
export function refusalResult(error: unknown, fallback: string) {
  if (error instanceof OnboardingRefusedError) {
    return {
      success: false as const,
      error: error.message,
      code: error.code,
      field: error.field,
      index: error.index,
    };
  }
  // Anything else is a database or implementation failure: its message is
  // for the log, never for the customer.
  return { success: false as const, error: fallback };
}

/**
 * Whether an entry can be linked by submitVerificationRequest: only a
 * server-issued upload id counts, so `{}` or a client flag never starts a review.
 */
export function isPersistableVerificationDoc(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  // A row exists for every upload; only a server-issued id can be linked.
  return Boolean(d.id && !d.isOnboardingUpload);
}

/**
 * Decide whether a consultant submission carries everything the verification
 * review needs. Both signals are required for an immediate review; anything
 * less defers to the dashboard's VerificationSection, which already owns the
 * post-onboarding submit/resubmit loop (#onboarding-ux).
 */
export function shouldSubmitVerification(body: VerificationSignals): {
  hasDocuments: boolean;
  hasLinkedin: boolean;
} {
  return {
    hasDocuments:
      Array.isArray(body.verificationDocuments) &&
      body.verificationDocuments.some(isPersistableVerificationDoc),
    hasLinkedin: Boolean(body.verificationLinkedinUrl?.trim()),
  };
}

/**
 * Email-ownership guard: `buildUserUpdateData` writes the body email to
 * `User`, so it must equal the verified session email (onboarding is self-only).
 */
export function resolveOnboardingEmailUpdate(args: {
  bodyEmail: unknown;
  sessionEmail: string | null | undefined;
}): { ok: true } | { ok: false; error: string } {
  // Absent/non-string emails are not our call — Zod requires `email` downstream
  // and rejects the body there with a field-level error.
  if (typeof args.bodyEmail !== "string") return { ok: true };
  const body = args.bodyEmail.trim().toLowerCase();
  const session = (args.sessionEmail ?? "").trim().toLowerCase();
  if (!body || body === session) return { ok: true };
  return { ok: false, error: "Email cannot be changed during onboarding" };
}

/**
 * Who may upload via `POST /api/verification/documents?onboarding=true`: a
 * consultant, a user still onboarding, or one eligible for add mode. Reads the
 * live `User` row (never the draft); the upload quotas bound abuse.
 */
export function canUploadVerificationDoc(args: {
  isOnboardingMode: boolean;
  hasConsultantProfile: boolean;
  user: OnboardingStateUser;
}): boolean {
  if (args.hasConsultantProfile) return true;
  if (!args.isOnboardingMode) return false;
  return (
    args.user.onboardingCompleted !== true ||
    canAddConsultantIdentity(args.user)
  );
}

/**
 * Who may write to the verification review queue (`/api/verification/submit`
 * + `/resubmit`). A `ConsultantProfile` row can outlive a role change, so the
 * live `User.role` must be CONSULTANT as well — otherwise an account that lost
 * the role could keep filing applications and paging admins.
 */
export function canSubmitVerification(args: {
  role: string | null | undefined;
  hasConsultantProfile: boolean;
}): boolean {
  return args.hasConsultantProfile && args.role === "CONSULTANT";
}

/** The `User` columns every onboarding predicate reads. */
export interface OnboardingStateUser {
  role: string | null | undefined;
  onboardingCompleted: boolean | null | undefined;
  consultantProfileId?: string | null | undefined;
  staffProfileId?: string | null | undefined;
}

/**
 * The one "fully onboarded" predicate for guards, the wizard and recovery.
 * Consultee and org-workspace profiles are created lazily, so only the
 * consultant and staff profiles are required.
 */
export function isFullyOnboarded(user: OnboardingStateUser): boolean {
  if (user.onboardingCompleted !== true) return false;
  if (user.role === "CONSULTANT") return !!user.consultantProfileId;
  if (user.role === "STAFF") return !!user.staffProfileId;
  return true;
}

/**
 * Who may add a consultant identity to an onboarded learner or org operator
 * (the wizard's add mode, e.g. after an EXPERT invite).
 */
export function canAddConsultantIdentity(user: OnboardingStateUser): boolean {
  return (
    user.onboardingCompleted === true &&
    !user.consultantProfileId &&
    (user.role === "CONSULTEE" || user.role === "ORG_WORKSPACE")
  );
}

// ============================================================================
// PROFESSIONAL BACKGROUND VALIDATION
// ============================================================================

/**
 * Parse the professional-background arrays. An absent array is `null` (skip);
 * an invalid one is refused with the field it belongs to, never dropped.
 */
export function validateProfessionalBackground(body: Record<string, unknown>) {
  return {
    workExperiences: parseBackground(
      body,
      "workExperiences",
      z.array(WorkExperienceSchema),
    ),
    educationHistory: parseBackground(
      body,
      "educationHistory",
      z.array(EducationSchema),
    ),
    certificationsList: parseBackground(
      body,
      "certificationsList",
      z.array(CertificationSchema),
    ),
    achievements: parseBackground(
      body,
      "achievements",
      z.array(AchievementCreateInputSchema),
    ),
  };
}

function parseBackground<T extends z.ZodTypeAny>(
  body: Record<string, unknown>,
  field: string,
  schema: T,
): z.infer<T> | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const index = issue?.path.find((p): p is number => typeof p === "number");
  throw new OnboardingRefusedError(
    "VALIDATION",
    issue?.message ?? "This entry is not valid",
    field,
    index,
  );
}
