import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LifeBuoy } from "lucide-react";

import { CategoryGrid } from "./_components/CategoryGrid";
import { SupportSearch } from "./_components/SupportSearch";
import { supportArticles } from "./_data/support-content";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Help Center | Familiarise",
  description:
    "Find answers about booking, payments, refunds, video sessions, payouts, and organisations on Familiarise.",
};

export default function SupportIndexPage() {
  return (
    <section className="w-full">
      {/* Hero with search — the search lives here, not in the navbar */}
      <div className="border-b border-border bg-muted/40">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-950">
            <LifeBuoy className="h-7 w-7 text-white" aria-hidden />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight">
            How can we help?
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-fluid-lg text-muted-foreground">
            Search {supportArticles.length} guides across booking, payments,
            video sessions, payouts, and organisations — or browse by topic.
          </p>
          <div className="mt-8">
            <Suspense>
              <SupportSearch />
            </Suspense>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-14">
        <h2 className="mb-6 text-fluid-2xl font-semibold tracking-tight">
          Browse by topic
        </h2>
        <CategoryGrid />

        <div className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
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
              <p className="mt-1 text-sm text-muted-foreground">{card.body}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
