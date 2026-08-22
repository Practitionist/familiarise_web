"use client";

import { useRef } from "react";
import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { CATEGORIES } from "./data";

function CategoryTile({
  category,
  index,
}: {
  category: { icon: LucideIcon; name: string; count: string };
  index: number;
}) {
  const Icon = category.icon;

  return (
    <Link
      href={`/explore/experts?category=${category.name.toLowerCase()}`}
      className="group relative flex min-h-[180px] w-[240px] shrink-0 snap-start flex-col justify-between overflow-hidden rounded-2xl border border-border bg-card p-6 transition-all duration-500 hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-[260px]"
    >
      {/* Invert on hover */}
      <div
        aria-hidden
        className="absolute inset-0 translate-y-full bg-zinc-950 transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-y-0"
      />
      <div className="relative z-10 flex items-start justify-between">
        <Icon className="h-6 w-6 text-foreground transition-colors duration-500 group-hover:text-white" />
        <span className="font-mono text-xs text-muted-foreground transition-colors duration-500 group-hover:text-zinc-500">
          {String(index + 1).padStart(2, "0")}
        </span>
      </div>
      <div className="relative z-10">
        <h4 className="text-lg font-semibold tracking-tight text-foreground transition-colors duration-500 group-hover:text-white">
          {category.name}
        </h4>
        <p className="text-sm text-muted-foreground transition-colors duration-500 group-hover:text-zinc-400">
          {category.count}
        </p>
      </div>
    </Link>
  );
}

export function CategoriesSection() {
  const railRef = useRef<HTMLDivElement>(null);

  return (
    <section className="bg-smoke py-20 md:py-28 relative overflow-hidden">
      <div className="container mx-auto px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          viewport={{ once: true }}
          className="mb-12 flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
        >
          <div>
            <Badge variant="secondary" className="mb-4 rounded-full border-0">
              Categories
            </Badge>
            <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground">
              Browse by <span className="text-muted-foreground">expertise</span>
            </h2>
          </div>
          {/* Scroll affordance for pointer devices; touch users swipe natively */}
          <div className="hidden gap-2 md:flex">
            {[-1, 1].map((dir) => (
              <button
                key={dir}
                type="button"
                aria-label={dir === -1 ? "Scroll categories left" : "Scroll categories right"}
                onClick={() =>
                  railRef.current?.scrollBy({
                    left: dir * 300,
                    behavior: "smooth",
                  })
                }
                className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ transform: dir === -1 ? "rotate(180deg)" : undefined }}
                >
                  <path
                    d="M3 8h10M9 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          viewport={{ once: true }}
        >
          <div
            ref={railRef}
            className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 scrollbar-hide mask-fade-x md:-mx-6 md:px-6"
          >
            {CATEGORIES.map((category, index) => (
              <CategoryTile
                key={category.name}
                category={category}
                index={index}
              />
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
