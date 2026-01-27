/**
 * Professional Background Validation Utilities
 * Validates and calculates completion percentages for user professional background
 */

import {
  UserRole,
  WorkExperience,
  Education,
  Certification,
} from "@prisma/client";

export interface ProfessionalBackgroundData {
  workExperiences: WorkExperience[];
  education: Education[];
  certifications: Certification[];
}

export interface ValidationRequirement {
  field: string;
  label: string;
  required: number;
  current: number;
  met: boolean;
}

export interface ProfessionalBackgroundValidation {
  isComplete: boolean;
  completionPercentage: number;
  requirements: ValidationRequirement[];
  missingFields: string[];
}

// Requirements per role
const ROLE_REQUIREMENTS: Record<
  string,
  { workExp: number; education: number; certifications: number }
> = {
  CONSULTANT: { workExp: 1, education: 1, certifications: 1 },
  CONSULTEE: { workExp: 0, education: 1, certifications: 0 },
  STAFF: { workExp: 0, education: 0, certifications: 0 },
  ADMIN: { workExp: 0, education: 0, certifications: 0 },
};

// Weight of each field for completion percentage
const FIELD_WEIGHTS = {
  workExp: 40,
  education: 35,
  certifications: 25,
};

/**
 * Validates professional background based on user role
 */
export function validateProfessionalBackground(
  role: UserRole | string,
  data: ProfessionalBackgroundData,
): ProfessionalBackgroundValidation {
  const requirements = ROLE_REQUIREMENTS[role] || ROLE_REQUIREMENTS.CONSULTEE;

  const validationResults: ValidationRequirement[] = [];
  const missingFields: string[] = [];

  // Validate work experience
  const workExpCount = data.workExperiences?.length || 0;
  const workExpMet = workExpCount >= requirements.workExp;
  if (requirements.workExp > 0) {
    validationResults.push({
      field: "workExperiences",
      label: "Work Experience",
      required: requirements.workExp,
      current: workExpCount,
      met: workExpMet,
    });
    if (!workExpMet) {
      missingFields.push(`Work Experience (at least ${requirements.workExp})`);
    }
  }

  // Validate education
  const educationCount = data.education?.length || 0;
  const educationMet = educationCount >= requirements.education;
  if (requirements.education > 0) {
    validationResults.push({
      field: "education",
      label: "Education",
      required: requirements.education,
      current: educationCount,
      met: educationMet,
    });
    if (!educationMet) {
      missingFields.push(`Education (at least ${requirements.education})`);
    }
  }

  // Validate certifications
  const certCount = data.certifications?.length || 0;
  const certMet = certCount >= requirements.certifications;
  if (requirements.certifications > 0) {
    validationResults.push({
      field: "certifications",
      label: "Certifications",
      required: requirements.certifications,
      current: certCount,
      met: certMet,
    });
    if (!certMet) {
      missingFields.push(
        `Certification (at least ${requirements.certifications})`,
      );
    }
  }

  const isComplete = validationResults.every((r) => r.met);
  const completionPercentage = calculateCompletionPercentage(role, data);

  return {
    isComplete,
    completionPercentage,
    requirements: validationResults,
    missingFields,
  };
}

/**
 * Calculates completion percentage based on role requirements
 */
export function calculateCompletionPercentage(
  role: UserRole | string,
  data: ProfessionalBackgroundData,
): number {
  const requirements = ROLE_REQUIREMENTS[role] || ROLE_REQUIREMENTS.CONSULTEE;

  let totalWeight = 0;
  let earnedWeight = 0;

  // Work experience contribution
  if (requirements.workExp > 0) {
    totalWeight += FIELD_WEIGHTS.workExp;
    const workExpCount = data.workExperiences?.length || 0;
    const workExpProgress = Math.min(workExpCount / requirements.workExp, 1);
    earnedWeight += FIELD_WEIGHTS.workExp * workExpProgress;
  }

  // Education contribution
  if (requirements.education > 0) {
    totalWeight += FIELD_WEIGHTS.education;
    const educationCount = data.education?.length || 0;
    const educationProgress = Math.min(
      educationCount / requirements.education,
      1,
    );
    earnedWeight += FIELD_WEIGHTS.education * educationProgress;
  }

  // Certifications contribution
  if (requirements.certifications > 0) {
    totalWeight += FIELD_WEIGHTS.certifications;
    const certCount = data.certifications?.length || 0;
    const certProgress = Math.min(certCount / requirements.certifications, 1);
    earnedWeight += FIELD_WEIGHTS.certifications * certProgress;
  }

  // If no requirements, return 100%
  if (totalWeight === 0) return 100;

  return Math.round((earnedWeight / totalWeight) * 100);
}

/**
 * Gets human-readable requirements description for a role
 */
export function getRoleRequirementsDescription(
  role: UserRole | string,
): string[] {
  const requirements = ROLE_REQUIREMENTS[role] || ROLE_REQUIREMENTS.CONSULTEE;
  const descriptions: string[] = [];

  if (requirements.workExp > 0) {
    descriptions.push(
      `At least ${requirements.workExp} work experience${requirements.workExp > 1 ? "s" : ""}`,
    );
  }
  if (requirements.education > 0) {
    descriptions.push(
      `At least ${requirements.education} education entr${requirements.education > 1 ? "ies" : "y"}`,
    );
  }
  if (requirements.certifications > 0) {
    descriptions.push(
      `At least ${requirements.certifications} certification${requirements.certifications > 1 ? "s" : ""}`,
    );
  }

  return descriptions;
}

/**
 * Checks if a specific field is required for a role
 */
export function isFieldRequired(
  role: UserRole | string,
  field: "workExp" | "education" | "certifications",
): boolean {
  const requirements = ROLE_REQUIREMENTS[role] || ROLE_REQUIREMENTS.CONSULTEE;
  return requirements[field] > 0;
}

/**
 * Gets the minimum count required for a field based on role
 */
export function getMinimumCount(
  role: UserRole | string,
  field: "workExp" | "education" | "certifications",
): number {
  const requirements = ROLE_REQUIREMENTS[role] || ROLE_REQUIREMENTS.CONSULTEE;
  return requirements[field];
}
