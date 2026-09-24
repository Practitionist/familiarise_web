"use client";

import { motion } from "framer-motion";
import { ArrowRight, LucideIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { CATEGORIES } from "./data";

function CategoryCard({
  category,
  consultantCount,
  index,
}: {
  category: { icon: LucideIcon; name: string };
  /** Verified consultants in the domain of this name, or 0 when there is no
   *  such domain yet. Zero renders no line rather than "0 experts" (#1490). */
  consultantCount: number;
  index: number;
}) {
  const Icon = category.icon;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      whileInView={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      viewport={{ once: true }}
    >
      <Link
        href={`/explore/experts?domain=${encodeURIComponent(category.name)}#all-experts`}
        className="group flex h-full items-center gap-4 rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-foreground">
            {category.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {consultantCount > 0
              ? `${consultantCount} ${consultantCount === 1 ? "expert" : "experts"}`
              : "Explore this field"}
          </p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
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
    <section className="relative overflow-hidden bg-background py-20 md:py-28">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="mb-10 flex flex-col justify-between gap-5 md:flex-row md:items-end"
        >
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Browse by expertise
            </p>
            <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground">
              Go straight to your field.
            </h2>
          </div>
          <p className="max-w-md text-fluid-base leading-relaxed text-muted-foreground md:text-right">
            Filter the expert directory by the kind of knowledge you need.
          </p>
        </motion.div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          viewport={{ once: true }}
          className="mt-8 flex justify-center"
        >
          <Button asChild variant="outline" size="lg">
            <Link href="/explore/experts#domains">
              Browse every domain
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </motion.div>
      </div>
    </section>
  );
}
