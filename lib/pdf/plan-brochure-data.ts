import type { PlanLevel } from "@prisma/client";
import type { CurriculumItem } from "@/components/plans/PlanContentSections";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { formatCurrencyAmount } from "@/utils/formatting";

export type BrochurePlanType =
  | "classes"
  | "webinars"
  | "consultations"
  | "subscriptions";

export interface BrochureFaqItem {
  question: string;
  answer: string;
}

export interface BrochureSource {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  price?: number | null;
  priceCurrency?: string | null;
  language: string;
  level: PlanLevel;
  durationInMonths?: number | null;
  durationInHours?: number | null;
  sessionsPerWeek?: number | null;
  totalSessions?: number | null;
  totalHours?: number | null;
  maxParticipants?: number | null;
  trialEnabled?: boolean | null;
  learningOutcomes?: string[] | null;
  targetAudience?: string[] | null;
  whatsIncluded?: string[] | null;
  prerequisites?: string | null;
  materialProvided?: string | null;
  topics?: Array<{ id?: string; name: string } | string> | null;
  faqs?: Array<{ question: string; answer: string }> | null;
  consultantProfile?: {
    headline?: string | null;
    user: { name: string | null };
  } | null;
  classContents?: CurriculumItem[];
  subscriptionContents?: CurriculumItem[];
}

export interface PlanBrochureData {
  title: string;
  subtitle?: string | null;
  description?: string | null;
  kind: string;
  expertName: string | null;
  expertHeadline: string | null;
  priceFormatted: string | null;
  facts: string[];
  learningOutcomes: string[];
  targetAudience: string[];
  whatsIncluded: string[];
  prerequisites: string | null;
  materialProvided: string | null;
  topics: string[];
  faqs: BrochureFaqItem[];
  curriculum: CurriculumItem[];
  curriculumHeading: string;
  planUrl: string;
  generatedAt: string;
}

const PLAN_KIND_LABEL: Record<BrochurePlanType, string> = {
  classes: "Expert-led class",
  webinars: "Live webinar",
  consultations: "1:1 consultation",
  subscriptions: "Mentorship programme",
};

const CURRICULUM_HEADING: Record<BrochurePlanType, string> = {
  classes: "Course content",
  webinars: "Session outline",
  consultations: "Session overview",
  subscriptions: "Your roadmap",
};

function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildPlanFacts(source: BrochureSource, type: BrochurePlanType): string[] {
  const facts: string[] = [];

  if (type === "classes" || type === "subscriptions") {
    if (source.durationInMonths) {
      facts.push(pluralise(source.durationInMonths, "month"));
    }
    if (source.sessionsPerWeek) {
      facts.push(`${pluralise(source.sessionsPerWeek, "session")} per week`);
    }
  }

  if (type === "webinars" || type === "consultations") {
    if (source.durationInHours) {
      facts.push(pluralise(source.durationInHours, "hour"));
    }
  }

  if (type === "consultations") {
    facts.push("One-to-one");
  }

  if (type === "subscriptions") {
    if (source.totalSessions) {
      facts.push(`${pluralise(source.totalSessions, "session")} total`);
    }
    if (source.totalHours) {
      facts.push(`${source.totalHours}h total`);
    }
  }

  if ((type === "classes" || type === "webinars") && source.maxParticipants) {
    facts.push(`Up to ${source.maxParticipants} participants`);
  }

  facts.push(planLevelLabel(source.level));

  if (source.language) {
    facts.push(source.language);
  }

  if (type === "subscriptions" && source.trialEnabled) {
    facts.push("Trial available");
  }

  return facts;
}

function normaliseOptionalText(value: string | null | undefined): string | null {
  if (!value || value === "None") return null;
  return value;
}

/** Only explicit buyer-facing content belongs in a brochure, never attached files. */
export function createPlanBrochureData(
  source: BrochureSource,
  type: BrochurePlanType,
  baseUrl: string,
  now = new Date(),
): PlanBrochureData {
  let rawCurriculum: CurriculumItem[] | undefined;
  if (type === "classes") {
    rawCurriculum = source.classContents;
  } else if (type === "subscriptions") {
    rawCurriculum = source.subscriptionContents;
  }

  const priceFormatted =
    typeof source.price === "number" && Number.isFinite(source.price)
      ? formatCurrencyAmount(source.price, source.priceCurrency || "INR")
      : null;

  return {
    title: source.title,
    subtitle: normaliseOptionalText(source.subtitle),
    description: normaliseOptionalText(source.description),
    kind: PLAN_KIND_LABEL[type],
    expertName: normaliseOptionalText(source.consultantProfile?.user.name),
    expertHeadline: normaliseOptionalText(source.consultantProfile?.headline),
    priceFormatted,
    facts: buildPlanFacts(source, type),
    learningOutcomes: (source.learningOutcomes ?? []).filter(Boolean),
    targetAudience: (source.targetAudience ?? []).filter(Boolean),
    whatsIncluded: (source.whatsIncluded ?? []).filter(Boolean),
    prerequisites: normaliseOptionalText(source.prerequisites),
    materialProvided: normaliseOptionalText(source.materialProvided),
    topics: (source.topics ?? [])
      .map((topic) => (typeof topic === "string" ? topic : topic.name))
      .filter(Boolean),
    faqs: (source.faqs ?? [])
      .filter((faq) => Boolean(faq.question && faq.answer))
      .map((faq) => ({
        question: faq.question,
        answer: faq.answer,
      })),
    curriculum: (rawCurriculum ?? [])
      .map((item) => ({
        title: item.title,
        description: item.description,
        order: item.order,
        sectionLabel: item.sectionLabel,
        hoursAllotted: item.hoursAllotted,
        outcomes: [...(item.outcomes ?? [])],
      }))
      .sort((a, b) => a.order - b.order),
    curriculumHeading: CURRICULUM_HEADING[type],
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
  return `${slug || "familiarise-plan"}-brochure.pdf`;
}
