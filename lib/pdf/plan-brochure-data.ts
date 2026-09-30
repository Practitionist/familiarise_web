import type { PlanLevel } from "@prisma/client";
import type { CurriculumItem } from "@/components/plans/PlanContentSections";
import { planLevelLabel } from "@/lib/labels/plan-labels";

export type BrochurePlanType = "classes" | "subscriptions";

interface BrochureSource {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  language: string;
  level: PlanLevel;
  durationInMonths: number;
  sessionsPerWeek: number;
  learningOutcomes: string[];
  targetAudience: string[];
  whatsIncluded: string[];
  prerequisites?: string | null;
  consultantProfile?: { user: { name: string | null } } | null;
  classContents?: CurriculumItem[];
  subscriptionContents?: CurriculumItem[];
}

export interface PlanBrochureData {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  kind: string;
  expertName: string | null;
  facts: string[];
  learningOutcomes: string[];
  targetAudience: string[];
  whatsIncluded: string[];
  prerequisites: string | null;
  curriculum: CurriculumItem[];
  curriculumHeading: string;
  planUrl: string;
  generatedAt: string;
}

/** Only explicit buyer-facing content belongs in a brochure, never attached files. */
export function createPlanBrochureData(
  source: BrochureSource,
  type: BrochurePlanType,
  baseUrl: string,
  now = new Date(),
): PlanBrochureData {
  const items =
    type === "classes" ? source.classContents : source.subscriptionContents;
  return {
    title: source.title,
    subtitle: source.subtitle,
    description: source.description,
    kind: type === "classes" ? "Expert-led class" : "Mentorship programme",
    expertName: source.consultantProfile?.user.name ?? null,
    facts: [
      `${source.durationInMonths} month${source.durationInMonths === 1 ? "" : "s"}`,
      `${source.sessionsPerWeek} session${source.sessionsPerWeek === 1 ? "" : "s"} per week`,
      planLevelLabel(source.level),
      source.language,
    ],
    learningOutcomes: [...source.learningOutcomes],
    targetAudience: [...source.targetAudience],
    whatsIncluded: [...source.whatsIncluded],
    prerequisites:
      source.prerequisites && source.prerequisites !== "None"
        ? source.prerequisites
        : null,
    curriculum: (items ?? [])
      .map((item) => ({
        title: item.title,
        description: item.description,
        order: item.order,
        sectionLabel: item.sectionLabel,
        hoursAllotted: item.hoursAllotted,
        outcomes: [...(item.outcomes ?? [])],
      }))
      .sort((a, b) => a.order - b.order),
    curriculumHeading: type === "classes" ? "Course content" : "Your roadmap",
    planUrl: new URL(
      `/explore/programs/plans/${type}/${encodeURIComponent(source.id)}`,
      baseUrl,
    ).toString(),
    generatedAt: now.toISOString(),
  };
}

export function brochureFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return `${slug || "familiarise-plan"}-curriculum.pdf`;
}
