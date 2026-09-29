"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { cn } from "@/utils/tailwind";

interface SectionHeaderProps {
  title: string;
  /** Secondary line under the title. Added for the results headings, which
   *  want to carry the live result count without it becoming the title. */
  description?: React.ReactNode;
  seeAllHref?: string;
  onSeeAllClick?: () => void;
  icon?: React.ReactNode;
  className?: string;
}

/**
 * A section title with an optional "see all" action.
 *
 * Kept as a distinct component from `ExploreSectionHeader` because this one
 * takes a pre-rendered icon *node* (call sites pass `<Briefcase className=
 * "w-5 h-5 text-white" />`), whereas that one takes an icon *component* and
 * owns the chip styling. Two different contracts, so two components — but they
 * now agree on the things that had drifted: one icon-chip size, one title size,
 * one margin.
 *
 * Before this, the expert profile had three icon-chip sizes in use (`w-8`,
 * `w-9`, `w-10`) against two different title sizes, so two sections on the
 * same page did not look like the same kind of thing.
 */
export default function SectionHeader({
  title,
  description,
  seeAllHref,
  onSeeAllClick,
  icon,
  className,
}: SectionHeaderProps) {
  const showSeeAll = seeAllHref || onSeeAllClick;
  const actionClass =
    "group inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  return (
    <div className={cn("mb-5 flex items-center justify-between gap-4", className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-subtle text-brand-foreground-subtle [&>svg]:h-4 [&>svg]:w-4"
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {showSeeAll &&
        (onSeeAllClick ? (
          <button type="button" onClick={onSeeAllClick} className={actionClass}>
            See all
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </button>
        ) : (
          <Link href={seeAllHref!} className={actionClass}>
            See all
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        ))}
    </div>
  );
}
