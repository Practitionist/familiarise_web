"use client";

import Link from "next/link";
import {
  ArrowRight,
  Calendar,
  Check,
  CreditCard,
  DollarSign,
  Repeat,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PAGE_META, PRICING_DATA } from "../constants";

const SESSION_FORMATS = [
  {
    icon: Users,
    title: "1:1 Consultations",
    badge: "Per Session",
    priceGuidance: "Set per session · 30 to 120 mins",
    description:
      "Personalized 1-on-1 guidance tailored to your goals—from mock interviews and resume reviews to architecture deep dives.",
    highlights: [
      "Direct 1-on-1 video call with screen sharing",
      "Transparent per-session rate set by the expert",
      "Full consultant-fee refund >24h before 1:1 sessions (50% for 12–24h)",
    ],
    href: "/explore/experts",
    cta: "Find an Expert",
  },
  {
    icon: Calendar,
    title: "Classes",
    badge: "Cohort-based",
    priceGuidance: "Full course enrollment · Multi-week",
    description:
      "Structured, multi-session live cohorts with hands-on curriculum, peer interaction, and shared learning materials.",
    highlights: [
      "Scheduled multi-session live curriculum",
      "Course materials, resources & recordings",
      "Small cohort sizes for active Q&A",
    ],
    href: "/explore/programs?type=class",
    cta: "Browse Classes",
  },
  {
    icon: Video,
    title: "Webinars",
    badge: "Single Event",
    priceGuidance: "Accessible group ticket · 60 to 180 mins",
    description:
      "Focused live workshops and topical briefings led by industry practitioners with live audience Q&A.",
    highlights: [
      "Most accessible price point for live learning",
      "Interactive Q&A with the host",
      "Live seat counts and instant confirmation",
    ],
    href: "/explore/programs?type=webinar",
    cta: "Explore Webinars",
  },
  {
    icon: Repeat,
    title: "Subscriptions",
    badge: "Recurring",
    priceGuidance: "Monthly or multi-month mentorship",
    description:
      "Ongoing mentorship plans with recurring 1-on-1 check-ins, async chat support, and structured career progression.",
    highlights: [
      "Regular recurring sessions every week or month",
      "Continuous follow-ups and goal tracking",
      "Cancel anytime before the next billing cycle",
    ],
    href: "/explore/experts",
    cta: "Explore Mentors",
  },
] as const;

export default function PricingPage() {
  return (
    <main className="min-h-screen w-full bg-background">
      {/* Dark Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white pt-32 pb-20 md:pb-28">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[760px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),transparent)]"
        />

        <div className="container relative z-10 mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/80 px-4 py-1.5 text-sm text-zinc-300 backdrop-blur-sm">
            <Sparkles className="h-4 w-4 text-zinc-300" aria-hidden />
            <span>{PAGE_META.pricing.description}</span>
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl mb-6 font-bold tracking-tight">
            Transparent,{" "}
            <span className="silver-text">expert-set pricing</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg leading-relaxed text-zinc-400 md:text-xl">
            No subscriptions required to browse, and zero hidden checkout fees.
            Every practitioner sets their own rates—what you see on the profile
            is the exact amount you pay.
          </p>
        </div>
      </section>

      {/* 4 Session Format Cards */}
      <section className="py-20 md:py-24">
        <div className="container mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8">
          <div className="mb-12 max-w-2xl">
            <Badge variant="secondary" className="mb-3">
              Session Formats
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              Four ways to learn, priced for how you use them
            </h2>
            <p className="mt-3 text-muted-foreground">
              Choose between a single focused call, a live group workshop, a
              multi-week cohort, or ongoing mentorship.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {SESSION_FORMATS.map((format) => {
              const Icon = format.icon;
              return (
                <div
                  key={format.title}
                  className="flex h-full flex-col justify-between rounded-2xl border border-border bg-card p-6 shadow-elevation-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevation-2"
                >
                  <div>
                    <div className="mb-5 flex items-center justify-between gap-2">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                        <Icon className="h-5 w-5" aria-hidden />
                      </div>
                      <Badge variant="secondary">{format.badge}</Badge>
                    </div>

                    <h3 className="text-lg font-bold tracking-tight text-foreground">
                      {format.title}
                    </h3>
                    <p className="mt-1 text-xs font-medium text-muted-foreground">
                      {format.priceGuidance}
                    </p>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {format.description}
                    </p>

                    <ul className="mt-5 space-y-2.5 border-t border-border pt-4">
                      {format.highlights.map((item) => (
                        <li
                          key={item}
                          className="flex items-start gap-2 text-xs leading-relaxed text-foreground/90"
                        >
                          <Check
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground"
                            aria-hidden
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="mt-6 pt-2">
                    <Button
                      asChild
                      variant="outline"
                      className="w-full justify-between"
                    >
                      <Link href={format.href}>
                        {format.cta}
                        <ArrowRight className="h-4 w-4" aria-hidden />
                      </Link>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 2-Column Section: How Pricing Works + Payment Methods & Buyer Protection */}
      <section className="bg-muted py-20 md:py-24">
        <div className="container mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            {/* Column 1: How Pricing Works & Platform Commission */}
            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-8">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                <DollarSign className="h-5 w-5 text-foreground" aria-hidden />
              </div>
              <h2 className="text-fluid-2xl font-bold tracking-tight text-foreground">
                How pricing works
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                At Familiarise, consultants set their own prices based on their
                experience, specialization, and session format.
              </p>

              <ul className="mt-6 space-y-3">
                {PRICING_DATA.howItWorks.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm">
                    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                      <Check className="h-3 w-3" aria-hidden />
                    </div>
                    <span className="leading-relaxed text-foreground">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-6 rounded-xl border border-border bg-muted/60 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  What the platform fee covers
                </p>
                <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {PRICING_DATA.commissionBenefits.map((benefit) => (
                    <li
                      key={benefit}
                      className="flex items-start gap-2 text-xs text-muted-foreground"
                    >
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground"
                        aria-hidden
                      />
                      <span>{benefit}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Column 2: Supported Payment Methods & Buyer Protection */}
            <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-8">
              <div>
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                  <ShieldCheck
                    className="h-5 w-5 text-foreground"
                    aria-hidden
                  />
                </div>
                <h2 className="text-fluid-2xl font-bold tracking-tight text-foreground">
                  Supported payment methods &amp; buyer protection
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  All transactions are processed in{" "}
                  <strong className="text-foreground">
                    INR (Indian Rupees)
                  </strong>{" "}
                  through our PCI-DSS compliant payment partner, Razorpay.
                </p>

                <div className="mt-6">
                  <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <CreditCard className="h-3.5 w-3.5" aria-hidden />
                    Accepted payment methods
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {PRICING_DATA.paymentMethods.map((method) => (
                      <Badge
                        key={method}
                        variant="secondary"
                        className="px-3 py-1 text-xs"
                      >
                        {method}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="mt-6 space-y-3 border-t border-border pt-6">
                  <div className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-foreground"
                      aria-hidden
                    />
                    <p className="text-sm text-muted-foreground">
                      <strong className="text-foreground">
                        Automatic host no-show remedy:
                      </strong>{" "}
                      If an expert is absent for a 1:1 consultation, it is
                      voided and refunded automatically.
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-foreground"
                      aria-hidden
                    />
                    <p className="text-sm text-muted-foreground">
                      <strong className="text-foreground">
                        Clear cancellation windows:
                      </strong>{" "}
                      Tiered cancellation windows for classes, webinars, and
                      subscriptions per our Refund Policy.
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-foreground"
                      aria-hidden
                    />
                    <p className="text-sm text-muted-foreground">
                      <strong className="text-foreground">
                        Encrypted checkout:
                      </strong>{" "}
                      Payment card and UPI credentials are never stored on
                      Familiarise servers.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-border bg-muted/60 p-4 text-xs text-muted-foreground">
                Read our full{" "}
                <Link
                  href="/refund"
                  className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  Cancellation &amp; Refund Policy
                </Link>{" "}
                for exact rules across consultations, classes, webinars, and
                subscriptions.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Unified FAQ Accordion */}
      <section className="py-20 md:py-24">
        <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 text-center">
            <Badge variant="secondary" className="mb-3">
              FAQ
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              Frequently asked pricing questions
            </h2>
            <p className="mt-2 text-muted-foreground">
              Everything you need to know about rates, billing, and refunds.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card px-6 shadow-elevation-1">
            <Accordion type="single" collapsible className="w-full">
              {PRICING_DATA.faqs.map((faq, index) => (
                <AccordionItem
                  key={faq.question}
                  value={`item-${index + 1}`}
                  className={
                    index === PRICING_DATA.faqs.length - 1 ? "border-b-0" : ""
                  }
                >
                  <AccordionTrigger className="py-5 text-left font-medium text-foreground hover:no-underline">
                    {faq.question}
                  </AccordionTrigger>
                  <AccordionContent className="pb-5 leading-relaxed text-muted-foreground">
                    {faq.answer}
                    {faq.question.includes("refund") && (
                      <>
                        {" "}
                        Please refer to our{" "}
                        <Link
                          href="/refund"
                          className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                        >
                          Cancellation &amp; Refund Policy
                        </Link>{" "}
                        for detailed information.
                      </>
                    )}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </div>
      </section>

      {/* Dark Closing CTA Band */}
      <section className="relative overflow-hidden bg-zinc-950 py-20 text-white md:py-28">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div className="container relative z-10 mx-auto max-w-2xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-fluid-3xl md:text-fluid-4xl mb-4 font-bold tracking-tight">
            Ready to start learning?
          </h2>
          <p className="mb-8 text-base leading-relaxed text-zinc-400 md:text-lg">
            Browse verified experts, compare session formats and exact rates,
            and book in minutes.
          </p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 rounded-xl bg-white px-8 text-zinc-900 hover:bg-zinc-100"
            >
              <Link href="/explore/experts">
                Explore Experts
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 rounded-xl border-zinc-700 bg-transparent px-8 text-white hover:bg-zinc-900 hover:text-white"
            >
              <Link href="/explore/programs">Browse Programs</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
