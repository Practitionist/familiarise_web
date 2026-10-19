"use client";

import Link from "next/link";

import {
  PlanFaqAccordion,
  type PlanFaqItem,
} from "@/components/plans/PlanContentSections";

/**
 * The Help Center topic that answers what a buyer is still unsure about at
 * checkout: which kind of session they are buying, how slots work, and what
 * cancelling returns. Deliberately the TOPIC, not the whole Help Center — a
 * link to the front door would be another place for the doubt to die.
 */
const HELP_HREF = "/support/booking";
const HELP_LABEL = "Browse booking, session-type and cancellation guides";

/**
 * The plan's own FAQs, shown at the moment of commitment.
 *
 * The buyer browses on the plan detail page and pays on the checkout page, so
 * the questions the consultant already answered ("what exactly do I get, is
 * this right for me") have to be answered again where the money is. Same
 * accordion as the detail page — one component, so the two never drift.
 */
export function PlanCheckoutFaq({
  faqs,
}: Readonly<{ faqs: PlanFaqItem[] | null | undefined }>) {
  if (!faqs?.length) return null;

  return (
    <div>
      <PlanFaqAccordion faqs={faqs} />
      <p className="mt-3 text-xs text-muted-foreground">
        Something this page doesn&apos;t answer?{" "}
        <Link href={HELP_HREF} className="underline underline-offset-2">
          {HELP_LABEL}
        </Link>{" "}
        in the Help Center.
      </p>
    </div>
  );
}
