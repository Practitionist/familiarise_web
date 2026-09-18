import { z } from "zod";
import type {
  ConsultantProfileCreateData,
  ConsulteeProfileCreateData,
  StaffProfileCreateData,
  AdminProfileCreateData,
} from "./onboarding";
import type { OnboardingData } from "./onboarding";
import {
  WorkExperienceSchema,
  EducationSchema,
  CertificationSchema,
} from "@/schemas/user";
import { AchievementCreateInputSchema } from "./onboarding";

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
    ...(data.termsAcceptedAt ? { termsAcceptedAt: data.termsAcceptedAt } : {}),
    ...(data.privacyAcceptedAt
      ? { privacyAcceptedAt: data.privacyAcceptedAt }
      : {}),
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

/** Build the scalar data for a staff profile upsert */
export function buildStaffScalarData(data: StaffProfileCreateData) {
  return {
    department: data.department ?? "",
    position: data.position ?? "",
  };
}

/** Build the scalar data for an admin profile upsert */
export function buildAdminScalarData(data: AdminProfileCreateData) {
  return {
    notes: data.notes ?? null,
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
 * Does this entry carry enough data for submitVerificationRequest to actually
 * persist or link it? Pure and structural so the deferral policy below and
 * the server-side persistence filters can never disagree on what counts as a
 * real document — mirrors exactly the two branches that create/link rows:
 *   - an existing record uploaded earlier via /api/verification/documents
 *   - an onboarding upload carrying its storage URL
 * An empty object like `{}` satisfies neither, so it must not start a review.
 */
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
      if (WIZARD_FIELDS.has(field)) {
        return new OnboardingRefusedError("VALIDATION", issue.message, field);
      }
    }
  }
  return new OnboardingRefusedError("VALIDATION", fallbackMessage);
}

/** Top-level wizard payload fields (mirrors app/form/onboarding/field-map.ts). */
const WIZARD_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "address",
  "timezone",
  "gender",
  "city",
  "country",
  "linkedinUrl",
  "bio",
  "dateOfBirth",
  "image",
  "role",
  "description",
  "headline",
  "experience",
  "domain",
  "domainId",
  "subDomains",
  "tags",
  "languages",
  "toolsAndTechnologies",
  "offeringFormats",
  "workExperiences",
  "educationHistory",
  "certificationsList",
  "achievements",
  "scheduleType",
  "weeklySlots",
  "customSlots",
  "termsAccepted",
  "privacyAccepted",
  "termsAcceptedAt",
  "privacyAcceptedAt",
  "verificationLinkedinUrl",
  "verificationNotes",
  "verificationDocuments",
  "aboutMe",
  "skillsToDevelop",
  "consulteeInlineEducation",
  "consulteeInlineWorkExperience",
  "department",
  "position",
]);

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
 * Email-ownership guard for the onboarding write boundary.
 *
 * `OnboardingBaseSchema` accepts any email and `buildUserUpdateData` writes it
 * straight to `User`, so without this check a caller could squat an
 * unregistered address (or someone else's) onto their row with no
 * re-verification — the only backstop was the `email @unique` constraint
 * surfacing as a 500-ish error. The session email is already verified at
 * signup (BetterAuth `requireEmailVerification`), so for self-service writes
 * the body email must equal it; privileged operators (ADMIN/STAFF writing
 * another user's row) bypass by design.
 *
 * Pure so both the server action and the PATCH route share one decision, and
 * so tests can pin it without a session.
 */
export function resolveOnboardingEmailUpdate(args: {
  bodyEmail: unknown;
  sessionEmail: string | null | undefined;
  isPrivileged: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (args.isPrivileged) return { ok: true };
  // Absent/non-string emails are not our call — Zod requires `email` downstream
  // and rejects the body there with a field-level error.
  if (typeof args.bodyEmail !== "string") return { ok: true };
  const body = args.bodyEmail.trim().toLowerCase();
  const session = (args.sessionEmail ?? "").trim().toLowerCase();
  if (!body || body === session) return { ok: true };
  return { ok: false, error: "Email cannot be changed during onboarding" };
}

/**
 * Who may upload via `POST /api/verification/documents?onboarding=true`.
 *
 * Transient onboarding uploads create NO database row, so the per-verification
 * count cap cannot see them — previously any authenticated user (any role, no
 * draft, no profile) could store unbounded 10MB objects. The consultant
 * wizard is the only legitimate caller, and by the agreement step it has both
 * picked CONSULTANT (persisted to the draft on step transition) and triggered
 * autosave — so gate on exactly that. Post-onboarding re-uploads use normal
 * mode with a profile and are unaffected.
 *
 * Pure so the route and tests share one decision.
 */
export function canUploadVerificationDoc(args: {
  isOnboardingMode: boolean;
  hasConsultantProfile: boolean;
  draftRole: string | null | undefined;
}): boolean {
  if (!args.isOnboardingMode) return args.hasConsultantProfile;
  if (args.hasConsultantProfile) return true;
  return args.draftRole === "CONSULTANT";
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

/**
 * Who may add a consultant identity to an already-onboarded account (PR-6 of
 * the onboarding train). EXPERT invites are strict — accepting needs a real
 * `ConsultantProfile` — but `requireNotOnboarded` keeps a finished user out of
 * the wizard, so a learner or an org operator invited as an expert had no way
 * forward. Pure so the layout guard, the action and the tests share it.
 */
export function canAddConsultantIdentity(user: {
  role: string | null | undefined;
  onboardingCompleted: boolean | null | undefined;
  consultantProfileId: string | null | undefined;
}): boolean {
  return (
    user.onboardingCompleted === true &&
    !user.consultantProfileId &&
    (user.role === "CONSULTEE" || user.role === "ORG_WORKSPACE")
  );
}

// ============================================================================
// PROFESSIONAL BACKGROUND VALIDATION
// ============================================================================

/** Validates and parses professional background arrays from raw body using Zod schemas.
 *  Returns validated data or null if input is missing/invalid. */
export function validateProfessionalBackground(body: Record<string, unknown>) {
  const workExperiences = Array.isArray(body.workExperiences)
    ? z.array(WorkExperienceSchema).safeParse(body.workExperiences)
    : null;

  const educationHistory = Array.isArray(body.educationHistory)
    ? z.array(EducationSchema).safeParse(body.educationHistory)
    : null;

  const certificationsList = Array.isArray(body.certificationsList)
    ? z.array(CertificationSchema).safeParse(body.certificationsList)
    : null;

  const achievements = Array.isArray(body.achievements)
    ? z.array(AchievementCreateInputSchema).safeParse(body.achievements)
    : null;

  return {
    workExperiences: workExperiences?.success ? workExperiences.data : null,
    educationHistory: educationHistory?.success ? educationHistory.data : null,
    certificationsList: certificationsList?.success
      ? certificationsList.data
      : null,
    achievements: achievements?.success ? achievements.data : null,
  };
}
