import "server-only";

import { z } from "zod";

import prisma from "@/lib/prisma";
import { recomputeProfileCompletion } from "@/lib/profiles/profile-completion";
import {
  CertificationSchema,
  EducationSchema,
  WorkExperienceSchema,
} from "@/schemas/user";
import { AchievementCreateInputSchema } from "@/utils/onboarding";
import { persistProfessionalBackground } from "@/utils/onboarding-server";

/**
 * #1527 §14 — Settings › Experience & education: the professional background
 * onboarding collects, editable afterwards. Same schemas and the same writer
 * (`persistProfessionalBackground`) as the onboarding submit, so the two
 * doors can never store different shapes.
 */

export const ExperienceBodySchema = z
  .object({
    workExperiences: z.array(WorkExperienceSchema).max(30),
    educationHistory: z.array(EducationSchema).max(20),
    certificationsList: z.array(CertificationSchema).max(30),
    achievements: z.array(AchievementCreateInputSchema).max(30),
  })
  .strict();

export type ExperienceBody = z.infer<typeof ExperienceBodySchema>;

/** Optional columns come back as null; the onboarding schemas want them absent. */
function withoutNulls<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  );
}

export async function readConsultantExperience(
  userId: string,
  consultantProfileId: string,
) {
  const workExperiences = await prisma.workExperience.findMany({
    where: { userId },
    orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
    select: {
      id: true,
      company: true,
      companyDomain: true,
      title: true,
      location: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
      description: true,
    },
  });
  const educationHistory = await prisma.education.findMany({
    where: { userId },
    orderBy: { endYear: "desc" },
    select: {
      id: true,
      institution: true,
      institutionDomain: true,
      degree: true,
      fieldOfStudy: true,
      startYear: true,
      endYear: true,
      grade: true,
      activities: true,
      description: true,
    },
  });
  const certificationsList = await prisma.certification.findMany({
    where: { userId },
    orderBy: { issueDate: "desc" },
    select: {
      id: true,
      name: true,
      issuingOrganization: true,
      issueDate: true,
      expiryDate: true,
      credentialId: true,
      credentialUrl: true,
    },
  });
  const achievements = await prisma.achievement.findMany({
    where: { consultantProfileId },
    select: {
      id: true,
      title: true,
      description: true,
      url: true,
      imageUrl: true,
      achievementType: true,
    },
  });
  return {
    workExperiences: workExperiences.map(withoutNulls),
    educationHistory: educationHistory.map(withoutNulls),
    certificationsList: certificationsList.map(withoutNulls),
    achievements: achievements.map(withoutNulls),
  };
}

/** Replaces all four lists, then refreshes the completion score they feed. */
export async function writeConsultantExperience(
  userId: string,
  consultantProfileId: string,
  body: ExperienceBody,
) {
  await prisma.$transaction(async (tx) => {
    await persistProfessionalBackground(userId, consultantProfileId, body, tx);
    await recomputeProfileCompletion(tx, consultantProfileId);
  });
}
