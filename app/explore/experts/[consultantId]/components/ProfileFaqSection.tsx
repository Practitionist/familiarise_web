"use client";

import { PlanFaqAccordion } from "@/components/plans/PlanContentSections";
import type { ConsultantDetailData } from "../types";

/**
 * A buyer deciding whether to book needs the objections answered on the
 * profile, not one click deeper on a plan page. The questions already exist,
 * author-written per plan, so the profile flattens them into one section
 * rather than asking every expert to maintain a second copy.
 */

/** Enough to answer a booking decision without turning the profile into a wall
 *  of text; the full list stays on each plan's own page. */
const MAX_PROFILE_FAQS = 6;

type PlanFaqItem = NonNullable<
  ConsultantDetailData["consultationPlans"][number]["faqs"]
>[number];

/** Exported for its ordering/dedupe rules, which the profile relies on more
 *  than the rendering does. */
export function collectProfileFaqs(
  plans: ConsultantDetailData["consultationPlans"],
): PlanFaqItem[] {
  const seen = new Set<string>();
  const collected: PlanFaqItem[] = [];

  for (const plan of plans) {
    for (const faq of plan.faqs ?? []) {
      // The same question is commonly pasted onto every plan; a profile that
      // repeats it once per plan reads as broken rather than thorough.
      const key = faq.question.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push(faq);
      if (collected.length >= MAX_PROFILE_FAQS) return collected;
    }
  }

  return collected;
}

export function ProfileFaqSection({
  consultantDetails,
}: Readonly<{ consultantDetails: ConsultantDetailData }>) {
  const faqs = collectProfileFaqs(consultantDetails.consultationPlans);
  if (faqs.length === 0) return null;

  return <PlanFaqAccordion faqs={faqs} />;
}
