/**
 * Nested-write helpers for a plan's child content rows.
 *
 * `PlanFaq` and the two curriculum tables (`ClassContent`,
 * `SubscriptionContent`) are authored as a whole ordered list, not as
 * individually-addressable rows: the planner hands back the full array on every
 * save. Replacing the set is therefore the correct update semantic, and doing
 * it as a single nested write keeps it inside the update's own transaction — an
 * external deleteMany followed by a separate create would leave the plan with
 * no FAQ if the second call failed.
 *
 * `order` is always re-derived from array position rather than trusted from the
 * client, so the sequence a consultant sees is the sequence a buyer gets.
 */

type FaqInput = {
  question: string;
  answer: string;
  order?: number;
};

type CurriculumInput = {
  title: string;
  description: string;
  contentType?: string | null;
  contentUrl?: string | null;
  hoursAllotted: number;
  sectionLabel?: string | null;
  outcomes?: string[];
};

/** Nested `create` for a brand-new plan. */
export function faqCreateNested(faqs: FaqInput[] | undefined) {
  return {
    create: (faqs ?? []).map((faq, index) => ({
      question: faq.question,
      answer: faq.answer,
      order: index,
    })),
  };
}

/**
 * Nested replace for an update. Returns `undefined` when the caller did not
 * send the field at all, so a PATCH that omits `faqs` leaves them untouched
 * rather than silently wiping them.
 */
export function faqReplaceNested(faqs: FaqInput[] | undefined) {
  if (faqs === undefined) return undefined;
  return {
    deleteMany: {},
    create: faqs.map((faq, index) => ({
      question: faq.question,
      answer: faq.answer,
      order: index,
    })),
  };
}

export function curriculumCreateNested(items: CurriculumInput[] | undefined) {
  return {
    create: (items ?? []).map((item, index) => ({
      title: item.title,
      description: item.description,
      contentType: item.contentType ?? null,
      contentUrl: item.contentUrl ?? null,
      hoursAllotted: item.hoursAllotted,
      sectionLabel: item.sectionLabel || null,
      outcomes: item.outcomes ?? [],
      order: index + 1,
    })),
  };
}

/** See {@link faqReplaceNested} for the undefined-means-untouched contract. */
export function curriculumReplaceNested(items: CurriculumInput[] | undefined) {
  if (items === undefined) return undefined;
  return {
    deleteMany: {},
    create: items.map((item, index) => ({
      title: item.title,
      description: item.description,
      contentType: item.contentType ?? null,
      contentUrl: item.contentUrl ?? null,
      hoursAllotted: item.hoursAllotted,
      sectionLabel: item.sectionLabel || null,
      outcomes: item.outcomes ?? [],
      order: index + 1,
    })),
  };
}

/** Standard include for reading a plan's buyer-facing content back out. */
export const planContentInclude = {
  faqs: { orderBy: { order: "asc" } },
} as const;
