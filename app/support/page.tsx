import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FileText } from "lucide-react";

import { CategoryGrid } from "./_components/CategoryGrid";
import { SupportSearch } from "./_components/SupportSearch";
import {
  SupportSidebar,
  SupportSidebarMobile,
} from "./_components/SupportSidebar";
import {
  articleUrl,
  getArticle,
  supportArticles,
} from "./_data/support-content";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Help Center | Familiarise",
  description:
    "Find answers about booking, payments, refunds, video sessions, payouts, and organisations on Familiarise.",
};

/** Most-visited guides, mirroring the reference layout's popular list. */
const POPULAR: [string, string][] = [
  ["payments", "refunds-explained"],
  ["booking", "reschedule"],
  ["payments", "payment-methods-and-failures"],
  ["video", "how-to-join"],
  ["getting-started", "sso-sign-in"],
  ["experts", "payouts"],
];

export default function SupportIndexPage() {
  const popular = POPULAR.flatMap(([category, slug]) => {
    const article = getArticle(category, slug);
    return article ? [article] : [];
  });

  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        <div className="flex gap-10">
          <SupportSidebar />
          <div className="min-w-0 flex-1">
            <SupportSidebarMobile />
            <h1 className="max-w-2xl text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight">
              Search for answers or browse by topic
            </h1>
            <p className="mt-3 max-w-2xl text-fluid-lg text-muted-foreground">
              {supportArticles.length} guides across booking, payments, video
              sessions, payouts, and organisations.
            </p>
            {/* Search lives on this page, not in the navbar */}
            <div className="mt-8 max-w-xl">
              <Suspense>
                <SupportSearch />
              </Suspense>
            </div>

            {popular.length > 0 && (
              <ul className="mt-10 divide-y divide-border border-y border-border">
                {popular.map((article) => (
                  <li key={`${article.category}/${article.slug}`}>
                    <Link
                      href={articleUrl(article)}
                      className="group flex items-center justify-between gap-4 py-3.5"
                    >
                      <span className="font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
                        {article.title}
                      </span>
                      <FileText
                        className="h-5 w-5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <h2 className="mt-12 mb-6 text-fluid-2xl font-semibold tracking-tight">
              Collections
            </h2>
            <CategoryGrid />

            <div className="mt-12 grid gap-4 sm:grid-cols-3">
              {[
                {
                  title: "Cancellation & refunds",
                  body: "Binding policy for every session type.",
                  href: "/refund",
                },
                {
                  title: "Pricing & fees",
                  body: "How expert pricing and fees work.",
                  href: "/pricing",
                },
                {
                  title: "Still stuck?",
                  body: "Contact us — we reply in 24–48h on business days.",
                  href: "/contactus",
                },
              ].map((card) => (
                <Link
                  key={card.href + card.title}
                  href={card.href}
                  className="rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all hover:-translate-y-0.5 hover:shadow-elevation-2"
                >
                  <p className="font-semibold">{card.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {card.body}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
