"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Calendar,
  Check,
  Compass,
  Repeat,
  Sparkles,
  Target,
  Users,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  COMPANY_INFO,
  PAGE_META,
  ABOUT_DATA,
  getMailtoLink,
} from "../constants";

const OFFERING_ICONS = [Calendar, Video, Users, Repeat] as const;

export default function AboutPage() {
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
            <span>{PAGE_META.about.title}</span>
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl mb-6 font-bold tracking-tight">
            Bridging ambition and{" "}
            <span className="silver-text">real-world expertise</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg leading-relaxed text-zinc-400 md:text-xl">
            {PAGE_META.about.description}
          </p>
        </div>
      </section>

      {/* 2-Column Mission & Vision Editorial Section */}
      <section className="py-20 md:py-24">
        <div className="container mx-auto max-w-[1100px] px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-8">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                <Target className="h-5 w-5" aria-hidden />
              </div>
              <Badge variant="secondary" className="mb-3">
                Our Mission
              </Badge>
              <h2 className="text-fluid-2xl mb-3 font-bold tracking-tight text-foreground">
                Personal guidance, accessible to everyone
              </h2>
              <p className="leading-relaxed text-muted-foreground">
                {ABOUT_DATA.mission}
              </p>
            </div>

            <div className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-8">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                <Compass className="h-5 w-5" aria-hidden />
              </div>
              <Badge variant="secondary" className="mb-3">
                Our Vision
              </Badge>
              <h2 className="text-fluid-2xl mb-3 font-bold tracking-tight text-foreground">
                Where knowledge flows directly from practitioners
              </h2>
              <p className="leading-relaxed text-muted-foreground">
                {ABOUT_DATA.vision}
              </p>
            </div>
          </div>

          {/* 4-Card "What We Offer" Bento Grid */}
          <div className="mt-20">
            <div className="mb-10 max-w-2xl">
              <Badge variant="secondary" className="mb-3">
                What We Offer
              </Badge>
              <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
                Built for every stage of learning
              </h2>
              <p className="mt-2 text-muted-foreground">
                From a focused 30-minute career call to multi-week interactive
                cohorts.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {ABOUT_DATA.offerings.map((offering, index) => {
                const Icon = OFFERING_ICONS[index] ?? BookOpen;
                return (
                  <div
                    key={offering.title}
                    className="rounded-2xl border border-border bg-card p-6 shadow-elevation-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevation-2 md:p-7"
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                        <Icon
                          className="h-5 w-5 text-foreground"
                          aria-hidden
                        />
                      </div>
                      <Badge variant="outline">{offering.title}</Badge>
                    </div>
                    <h3 className="text-lg font-semibold text-foreground">
                      {offering.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {offering.description}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 3-Step "How It Works" Section on bg-muted */}
      <section className="bg-muted py-20 md:py-24">
        <div className="container mx-auto max-w-[1100px] px-4 sm:px-6 lg:px-8">
          <div className="mb-12 max-w-2xl">
            <Badge variant="secondary" className="mb-3">
              How It Works
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              Three steps from question to clarity
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {ABOUT_DATA.howItWorks.map((item) => (
              <div
                key={item.step}
                className="relative flex flex-col justify-between rounded-2xl border border-border bg-card p-6 shadow-elevation-1 md:p-7"
              >
                <div>
                  <div className="mb-6 flex items-center justify-between">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-950 text-sm font-bold text-white dark:bg-white dark:text-zinc-950">
                      0{item.step}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Step {item.step}
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 6-Card "Why Choose Familiarise" Grid with Lucide Check icons */}
      <section className="py-20 md:py-24">
        <div className="container mx-auto max-w-[1100px] px-4 sm:px-6 lg:px-8">
          <div className="mb-12 max-w-2xl">
            <Badge variant="secondary" className="mb-3">
              Platform Standards
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-foreground">
              Why choose {COMPANY_INFO.name}
            </h2>
            <p className="mt-2 text-muted-foreground">
              Every session is backed by verified profiles, integrated tooling,
              and transparent buyer protection.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ABOUT_DATA.benefits.map((benefit) => (
              <div
                key={benefit.title}
                className="flex items-start gap-4 rounded-2xl border border-border bg-card p-6 shadow-elevation-1"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                  <Check className="h-4 w-4" aria-hidden />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">
                    {benefit.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {benefit.description}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Company Information Strip */}
          <div className="mt-12 rounded-2xl border border-border bg-muted/50 p-6 md:p-8">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Platform Name
                </p>
                <p className="mt-1 font-semibold text-foreground">
                  {COMPANY_INFO.name}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  General Inquiries
                </p>
                <p className="mt-1">
                  <a
                    href={getMailtoLink()}
                    className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
                  >
                    {COMPANY_INFO.email}
                  </a>
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Headquarters
                </p>
                <p className="mt-1 text-sm text-foreground">
                  {COMPANY_INFO.address}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Dark Closing CTA Band */}
      <section className="relative overflow-hidden bg-zinc-950 py-20 text-white md:py-28">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div className="container relative z-10 mx-auto max-w-2xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-fluid-3xl md:text-fluid-4xl mb-4 font-bold tracking-tight">
            Join the {COMPANY_INFO.name} community
          </h2>
          <p className="mb-8 text-base leading-relaxed text-zinc-400 md:text-lg">
            Whether you&apos;re looking for a mentor to accelerate your career
            or ready to share your expertise with others, you&apos;re in the
            right place.
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
              <Link href="/become-an-expert">Become an Expert</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
