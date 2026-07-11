"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PainPoint {
  title: string;
  description: string;
}

interface Solution {
  title: string;
  description: string;
}

interface CategoryLink {
  label: string;
  href: string;
}

export interface UseCasePageData {
  /** Main headline */
  title: string;
  /** Subtitle / value proposition */
  subtitle: string;
  /** Primary CTA label (default: "Get Started") */
  ctaLabel?: string;
  /** Primary CTA href (default: "/auth/signup") */
  ctaHref?: string;
  /** 3-4 pain points the audience faces */
  painPoints: PainPoint[];
  /** 3-4 ways Familiarise solves those pain points */
  solutions: Solution[];
  /** Expert categories relevant to this audience */
  categories: CategoryLink[];
  /** Bottom CTA section headline */
  bottomCtaTitle: string;
  /** Bottom CTA section description */
  bottomCtaDescription: string;
}

// ─── Layout Component ────────────────────────────────────────────────────────

export default function UseCasePageLayout({ data }: { data: UseCasePageData }) {
  const ctaLabel = data.ctaLabel ?? "Get Started";
  const ctaHref = data.ctaHref ?? "/auth/signup";

  return (
    <div className="w-full">
      {/* Hero — intentional dark landing section */}
      <section className="bg-zinc-950 text-white py-24 md:py-32">
        <div className="container mx-auto px-4 md:px-6 text-center max-w-3xl">
          <h1 className="text-fluid-4xl font-bold tracking-tight mb-6">
            {data.title}
          </h1>
          <p className="text-lg text-zinc-400 mb-8 leading-relaxed">
            {data.subtitle}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href={ctaHref} className="w-full sm:w-auto">
              <Button
                size="lg"
                className="w-full sm:w-auto bg-white text-zinc-900 hover:bg-zinc-200 px-8 h-12 text-base"
              >
                {ctaLabel}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <Link href="/explore/experts" className="w-full sm:w-auto">
              <Button
                variant="outline"
                size="lg"
                className="w-full sm:w-auto bg-transparent border-zinc-600 text-white hover:bg-zinc-800 px-8 h-12 text-base"
              >
                Browse Experts
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Pain Points */}
      <section className="py-20 md:py-28 bg-card">
        <div className="container mx-auto px-4 md:px-6 max-w-5xl">
          <h2 className="text-fluid-3xl font-bold tracking-tight text-center mb-4">
            The Challenge
          </h2>
          <p className="text-lg text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Common problems that hold you back — and why generic solutions
            don&apos;t cut it.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {data.painPoints.map((point, i) => (
              <div
                key={i}
                className="p-6 rounded-2xl border border-border bg-card shadow-elevation-1"
              >
                <div className="w-10 h-10 rounded-xl bg-error/10 text-error flex items-center justify-center font-bold text-lg mb-4">
                  {i + 1}
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {point.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {point.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solutions */}
      <section className="py-20 md:py-28 bg-muted">
        <div className="container mx-auto px-4 md:px-6 max-w-5xl">
          <h2 className="text-fluid-3xl font-bold tracking-tight text-center mb-4">
            How Familiarise Helps
          </h2>
          <p className="text-lg text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Real guidance from real experts — not AI-generated advice or
            pre-recorded videos.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {data.solutions.map((solution, i) => (
              <div
                key={i}
                className="p-6 rounded-2xl border border-border bg-card shadow-elevation-1"
              >
                <div className="w-10 h-10 rounded-xl bg-foreground text-card flex items-center justify-center font-bold text-lg mb-4">
                  {i + 1}
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {solution.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {solution.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Categories */}
      {data.categories.length > 0 && (
        <section className="py-20 md:py-28 bg-card">
          <div className="container mx-auto px-4 md:px-6 max-w-4xl text-center">
            <h2 className="text-fluid-3xl font-bold tracking-tight mb-4">
              Explore Experts by Domain
            </h2>
            <p className="text-lg text-muted-foreground mb-10 max-w-2xl mx-auto">
              Find verified consultants in the fields that matter to you.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              {data.categories.map((cat) => (
                <Link
                  key={cat.href}
                  href={cat.href}
                  className="px-5 py-2.5 rounded-full border border-border text-sm font-medium text-muted-foreground hover:bg-foreground hover:text-card hover:border-foreground transition-colors"
                >
                  {cat.label}
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Bottom CTA — intentional dark landing section */}
      <section className="py-20 md:py-28 bg-zinc-950 text-white">
        <div className="container mx-auto px-4 md:px-6 text-center max-w-2xl">
          <h2 className="text-fluid-3xl font-bold tracking-tight mb-4">
            {data.bottomCtaTitle}
          </h2>
          <p className="text-lg text-zinc-400 mb-8 leading-relaxed">
            {data.bottomCtaDescription}
          </p>
          <Link href={ctaHref} className="inline-block w-full sm:w-auto">
            <Button
              size="lg"
              className="w-full sm:w-auto bg-white text-zinc-900 hover:bg-zinc-200 px-8 h-12 text-base"
            >
              {ctaLabel}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
