import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { StillStuckCard } from "../_components/StillStuckCard";
import {
  SupportSidebar,
  SupportSidebarMobile,
} from "../_components/SupportSidebar";
import { articleUrl, faqIndexByCategory } from "../_data/support-content";
import { ACK_PROMISE_COPY, ANTI_SCAM_NOTICE } from "@/app/(pages)/constants";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Frequently asked questions | Familiarise Help Center",
  description:
    "Every question the Familiarise Help Center answers, in one index — booking, payments, refunds, video sessions, recordings, payouts, and organisations.",
};

/**
 * The Help Center's FAQ index.
 *
 * The Help Center is browsable by topic, but a reader who arrives with one
 * question has to guess which of eight categories holds it. This page answers
 * that by listing every question in the corpus, grouped by category, each one
 * linking to the article that answers it.
 *
 * It renders from the SAME static corpus the rest of the Help Center uses —
 * no second content model to drift — and is server-rendered under the same
 * ISR window, so the links a crawler sees are the links a reader gets.
 */
export default function SupportFaqIndexPage() {
  const groups = faqIndexByCategory();
  const questionCount = groups.reduce(
    (total, group) => total + group.articles.length,
    0,
  );

  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        <nav
          aria-label="Breadcrumb"
          className="mb-6 text-sm text-muted-foreground"
        >
          <ol className="flex flex-wrap items-center gap-1.5">
            <li>
              <Link href="/support" className="hover:text-foreground">
                Help Center
              </Link>
            </li>
            <li aria-hidden>
              <ChevronRight className="h-3.5 w-3.5" />
            </li>
            <li className="text-foreground">Frequently asked questions</li>
          </ol>
        </nav>

        <div className="flex gap-10">
          <SupportSidebar />
          <div className="min-w-0 flex-1">
            <SupportSidebarMobile />
            <h1 className="max-w-2xl text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight">
              Frequently asked questions
            </h1>
            <p className="mt-3 max-w-2xl text-fluid-lg text-muted-foreground">
              {questionCount} questions across {groups.length} topics. Every
              answer links to the full guide it comes from.
            </p>

            {groups.map((group) => (
              <section
                key={group.category.slug}
                id={group.category.slug}
                className="mt-10 scroll-mt-24"
                aria-labelledby={`faq-${group.category.slug}`}
              >
                <h2
                  id={`faq-${group.category.slug}`}
                  className="text-fluid-xl font-semibold tracking-tight"
                >
                  <Link
                    href={`/support/${group.category.slug}`}
                    className="hover:underline hover:underline-offset-4"
                  >
                    {group.category.title}
                  </Link>
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {group.category.description}
                </p>
                <ul className="mt-4 divide-y divide-border border-y border-border">
                  {group.articles.map((article) => (
                    <li key={`${article.category}/${article.slug}`}>
                      <Link
                        href={articleUrl(article)}
                        className="group flex flex-col gap-1 py-3.5"
                      >
                        <span className="font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
                          {article.title}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {article.excerpt}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            <div className="mt-12 grid gap-4 sm:grid-cols-2">
              <Link
                href="/support"
                className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all hover:-translate-y-0.5 hover:shadow-elevation-2"
              >
                <p className="font-semibold">Browse the Help Center</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Guides, checklists, and policy explanations by topic.
                </p>
              </Link>
              <StillStuckCard className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all hover:-translate-y-0.5 hover:shadow-elevation-2" />
            </div>
            <p className="mt-6 text-xs text-muted-foreground">
              We acknowledge all requests {ACK_PROMISE_COPY}. {ANTI_SCAM_NOTICE}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
