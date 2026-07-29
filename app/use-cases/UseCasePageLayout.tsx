"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  UseCaseCadence,
  UseCaseCategories,
  UseCaseChecklist,
  UseCaseClosing,
  UseCaseComparison,
  UseCaseDecoder,
  UseCaseFaqs,
  UseCaseHero,
  UseCaseMatrix,
  UseCasePains,
  UseCaseSessions,
  UseCaseTimeline,
  type UseCaseCategoriesData,
  type UseCaseClosingData,
  type UseCaseCta,
  type UseCaseComparisonData,
  type UseCaseFaq,
  type UseCaseHeroData,
  type UseCaseSectionData,
} from "./UseCaseSections";

export type { UseCaseIcon } from "./UseCaseSections";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The section that carries the segment's distinctive argument. Each of the four
 * pages picks a different renderer so they read as four pages, not one template
 * with the nouns swapped.
 */
export type UseCaseSpine = UseCaseSectionData & {
  variant: "timeline" | "decoder" | "matrix" | "cadence";
};

export type UseCaseSectionKey =
  | "pains"
  | "spine"
  | "sessions"
  | "checklist"
  | "comparison"
  | "categories"
  | "faqs";

export interface UseCasePageData {
  hero: UseCaseHeroData;
  pains: UseCaseSectionData;
  spine: UseCaseSpine;
  sessions: UseCaseSectionData;
  /** Optional — only pages with a genuine pre-flight list use it. */
  checklist?: UseCaseSectionData;
  comparison: UseCaseComparisonData;
  categories: UseCaseCategoriesData;
  faqs: {
    eyebrow: string;
    title: string;
    intro: string;
    items: UseCaseFaq[];
  };
  closing: UseCaseClosingData;
  /** Body order. Ordering is part of the argument, so each page sets its own. */
  order: UseCaseSectionKey[];
}

// ─── Sticky mobile CTA ───────────────────────────────────────────────────────

/**
 * These are long, high-consideration pages and the hero CTA scrolls away within
 * one screen on a phone. Appears only once the hero is behind you, so it never
 * competes with the CTA already on screen.
 */
function StickyMobileCta({ cta }: { cta: UseCaseCta }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className={`md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur-sm p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-transform duration-300 ${
        visible ? "translate-y-0" : "translate-y-full"
      }`}
      aria-hidden={!visible}
    >
      <Link href={cta.href} tabIndex={visible ? undefined : -1}>
        <Button size="lg" className="w-full h-12 text-base">
          {cta.label}
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </Link>
    </div>
  );
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export default function UseCasePageLayout({ data }: { data: UseCasePageData }) {
  const renderSection = (key: UseCaseSectionKey) => {
    switch (key) {
      case "pains":
        return <UseCasePains key={key} data={data.pains} />;
      case "spine":
        switch (data.spine.variant) {
          case "timeline":
            return <UseCaseTimeline key={key} data={data.spine} />;
          case "decoder":
            return <UseCaseDecoder key={key} data={data.spine} />;
          case "matrix":
            return <UseCaseMatrix key={key} data={data.spine} />;
          case "cadence":
            return <UseCaseCadence key={key} data={data.spine} />;
        }
        return null;
      case "sessions":
        return <UseCaseSessions key={key} data={data.sessions} />;
      case "checklist":
        return data.checklist ? (
          <UseCaseChecklist key={key} data={data.checklist} />
        ) : null;
      case "comparison":
        return <UseCaseComparison key={key} data={data.comparison} />;
      case "categories":
        return <UseCaseCategories key={key} data={data.categories} />;
      case "faqs":
        return (
          <UseCaseFaqs
            key={key}
            eyebrow={data.faqs.eyebrow}
            title={data.faqs.title}
            intro={data.faqs.intro}
            items={data.faqs.items}
          />
        );
    }
  };

  // Not for a rich result — Google retired FAQ rich results in May 2026
  // (https://developers.google.com/search/docs/appearance/structured-data/faqpage).
  // FAQPage is still a valid type that crawlers and answer engines parse, and
  // these pages are the site's main organic-search surface, so it is cheap to
  // keep emitting.
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: data.faqs.items.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };

  return (
    <div className="w-full">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <UseCaseHero data={data.hero} />
      {data.order.map(renderSection)}
      <UseCaseClosing data={data.closing} />
      <StickyMobileCta cta={data.hero.primaryCta} />
    </div>
  );
}
