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
    sessionTypes: data.sessionTypes ?? [],
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
    occupation: data.occupation ?? "",
    aboutMe: data.aboutMe ?? "",
    preferredLanguage: data.preferredLanguage ?? "",
    goals,
    careerStage: data.careerStage ?? null,
    currentCompany: data.currentCompany ?? null,
    industry: data.industry ?? null,
    skillsToDevelop: data.skillsToDevelop ?? [],
    budgetPreference: data.budgetPreference ?? null,
  };
}

/** Build the scalar data for a staff profile upsert */
export function buildStaffScalarData(data: StaffProfileCreateData) {
  return {
    department: data.department ?? "",
    position: data.position ?? "",
    permissions: data.permissions ?? {},
    responsibilities: data.responsibilities ?? {},
    employeeId: data.employeeId ?? null,
    hireDate: data.hireDate ?? null,
    reportsTo: data.reportsTo ?? null,
    skills: data.skills ?? [],
    workSchedule: data.workSchedule ?? null,
  };
}

/** Build the scalar data for an admin profile upsert */
export function buildAdminScalarData(data: AdminProfileCreateData) {
  return {
    adminLevel: data.adminLevel,
    accessScope: data.accessScope ?? null,
    assignedRegions: data.assignedRegions ?? [],
    notes: data.notes ?? null,
  };
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
    workExperiences:
      workExperiences?.success ? workExperiences.data : null,
    educationHistory:
      educationHistory?.success ? educationHistory.data : null,
    certificationsList:
      certificationsList?.success ? certificationsList.data : null,
    achievements: achievements?.success ? achievements.data : null,
  };
}
