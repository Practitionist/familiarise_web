"use client";

import { useState } from "react";
import Link from "next/link";
import { Hash } from "lucide-react";

import { cn } from "@/utils/tailwind";
import { ExploreSectionHeader } from "./ExploreShell";

/**
 * One category/domain grid.
 *
 * `DomainGrid` (experts) and `CategoryGrid` (programs) were 93 and 98 lines
 * respectively and differed only in: the icon (`Layers` vs `Hash`), the count
 * noun (`expert(s)` vs `program(s)`), and the "View all" label. The button's
 * class string was byte-identical. The scroll-chrome, the `INITIAL_DISPLAY = 9`
 * cap, the `+N more` arithmetic and the skeleton were all forked.
 *
 * `noun` is therefore a prop and the two grids are gone.
 */
export function CategoryGrid({
  categories,
  noun,
  icon: Icon = Hash,
  heading,
  viewAllHref,
  initialDisplay = 9,
  onSelect,
}: {
  categories: { id: string; name: string; count: number }[];
  /** Singular then plural — drives the count label: "12 experts" / "3 programs". */
  noun: [string, string];
  icon?: React.ComponentType<{ className?: string }>;
  heading?: string;
  viewAllHref?: string;
  initialDisplay?: number;
  /**
   * Applies a filter in place instead of navigating. Both the original grids
   * used this (they call the owning page's `onDomainSelect` /
   * `onTopicSelect`); the href form is kept for the org directory, which does
   * navigate. A tile is a real `<Link>` either way so it stays middle-clickable
   * and prefetched — `onSelect` fires alongside, never instead of.
   */
  onSelect?: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [singular, plural] = noun;

  if (categories.length === 0) return null;

  const visible = expanded
    ? categories
    : categories.slice(0, initialDisplay);
  const hidden = categories.length - visible.length;
  const baseHref = viewAllHref ?? "";

  return (
    <section>
      <ExploreSectionHeader title={heading ?? "Browse by category"} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {visible.map((category) => (
          <Link
            key={category.id}
            href={
              onSelect
                ? baseHref || "#"
                : `${baseHref}?category=${encodeURIComponent(category.name)}`
            }
            onClick={() => onSelect?.(category.name)}
            scroll={false}
            className={cn(
              "group flex items-center gap-3 rounded-card border border-border bg-card p-3.5",
              "shadow-elevation-1 shadow-edge transition-[transform,box-shadow,border-color] duration-200",
              "hover:-translate-y-0.5 hover:border-brand-border hover:shadow-elevation-2",
            )}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground transition-colors group-hover:bg-brand-subtle group-hover:text-brand-foreground-subtle"
              aria-hidden="true"
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              {/* `text-sm` not `text-xs`: these carry the category name, which
                  is the reason the tile exists. The old tile ran at 12px with
                  the count competing for the same line. */}
              <span className="block truncate text-sm font-medium text-foreground transition-colors group-hover:text-brand-foreground-subtle">
                {category.name}
              </span>
              <span className="tnum block text-xs text-muted-foreground">
                {category.count} {category.count === 1 ? singular : plural}
              </span>
            </span>
          </Link>
        ))}
      </div>

      {(hidden > 0 || expanded) && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-sm font-medium text-brand-foreground-subtle underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {expanded
              ? "Show fewer"
              : `Show ${hidden} more ${hidden === 1 ? singular : plural}`}
          </button>
        </div>
      )}
    </section>
  );
}

/** Placeholder matching the real tile's shape, so the grid does not reflow. */
export function CategoryGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-card border border-border bg-card p-3.5"
        >
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-control bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
