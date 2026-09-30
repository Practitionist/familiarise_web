"use client";

import { motion } from "framer-motion";
import { ArrowRight, ChevronRight, LucideIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { CATEGORIES } from "./data";

function CategoryCard({
  category,
  consultantCount,
  index,
}: {
  category: {
    icon: LucideIcon;
    name: string;
    description?: string;
    color: string;
  };
  /** Verified consultants in the domain of this name, or 0 when there is no
   *  such domain yet. Zero renders no line rather than "0 experts" (#1490). */
  consultantCount: number;
  index: number;
}) {
  const Icon = category.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.04 }}
      viewport={{ once: true }}
    >
      <Link
        href={`/explore/experts?domain=${encodeURIComponent(category.name.toLowerCase())}`}
        className="group block h-full rounded-2xl border border-border bg-card p-6 shadow-elevation-1 hover:border-foreground/30 hover:shadow-elevation-2 transition-all duration-200"
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="w-11 h-11 rounded-xl bg-zinc-900 text-white flex items-center justify-center shrink-0">
            <Icon className="w-5 h-5" />
          </div>
          <div className="flex items-center gap-1.5">
            {consultantCount > 0 && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
                {consultantCount === 1
                  ? "1 expert"
                  : `${consultantCount} experts`}
              </span>
            )}
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
          </div>
        </div>
        <h3 className="text-base font-semibold text-foreground mb-1.5">
          {category.name}
        </h3>
        {category.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {category.description}
          </p>
        )}
      </Link>
    </motion.div>
  );
}

export function CategoriesSection({
  consultantsByDomain,
}: {
  /** Verified consultant counts keyed by lowercased domain name (#1490). */
  consultantsByDomain: Record<string, number>;
}) {
  return (
    <section className="py-20 md:py-28 bg-background border-b border-border">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-12">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              Explore by Domain
            </p>
            <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-foreground tracking-tight mb-2">
              Find specialists across every discipline
            </h2>
            <p className="text-base text-muted-foreground max-w-2xl">
              Filter by domain, seniority, and session format to connect with
              practitioners who have solved your exact challenge.
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            className="h-11 px-5 rounded-xl border-border hover:bg-muted shrink-0 self-start md:self-auto"
          >
            <Link href="/explore/experts">
              View All Domains
              <ArrowRight className="ml-2 w-4 h-4" />
            </Link>
          </Button>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {CATEGORIES.map((category, index) => (
            <CategoryCard
              key={category.name}
              category={category}
              consultantCount={
                consultantsByDomain[category.name.toLowerCase()] ?? 0
              }
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
