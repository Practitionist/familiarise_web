"use client";

import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { CATEGORIES } from "./data";
import { Em, Reveal, Section, SectionHeading } from "./primitives";

export function CategoriesSection({
  consultantsByDomain,
}: {
  /** Verified consultant counts keyed by lowercased domain name (#1490). */
  consultantsByDomain: Record<string, number>;
}) {
  return (
    <Section id="categories">
      <SectionHeading
        eyebrow="Categories"
        title={
          <>
            Browse by <Em>expertise</Em>
          </>
        }
        description="Find someone who has already done the thing you're trying to do."
        action={
          <Link
            href="/explore/experts"
            className="group inline-flex items-center gap-1.5 text-sm text-zinc-300 transition-colors hover:text-white"
          >
            View all experts
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        }
      />

      <ul className="grid overflow-hidden rounded-2xl border border-white/[0.08] sm:grid-cols-2 lg:grid-cols-4">
        {CATEGORIES.map((category, i) => {
          const Icon = category.icon;
          // Zero renders no line rather than "0 experts" (#1490).
          const count = consultantsByDomain[category.name.toLowerCase()] ?? 0;
          return (
            <Reveal
              as="li"
              key={category.name}
              delay={i * 0.03}
              className="-mb-px -mr-px border-b border-r border-white/[0.08]"
            >
              <Link
                href={`/explore/experts?domain=${category.name.toLowerCase()}`}
                className="group flex h-full items-center gap-4 p-6 transition-colors hover:bg-white/[0.03]"
              >
                <Icon className="h-5 w-5 shrink-0 text-zinc-400 transition-colors group-hover:text-white" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-white">
                    {category.name}
                  </p>
                  {count > 0 && (
                    <p className="truncate text-sm text-zinc-500">
                      {count === 1 ? "1 expert" : `${count} experts`}
                    </p>
                  )}
                </div>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-zinc-600 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white" />
              </Link>
            </Reveal>
          );
        })}
      </ul>
    </Section>
  );
}
