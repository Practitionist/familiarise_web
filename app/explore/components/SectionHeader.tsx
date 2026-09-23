"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

interface SectionHeaderProps {
  title: string;
  seeAllHref?: string;
  onSeeAllClick?: () => void;
  icon?: React.ReactNode;
}

export default function SectionHeader({
  title,
  seeAllHref,
  onSeeAllClick,
  icon,
}: SectionHeaderProps) {
  const showSeeAll = seeAllHref || onSeeAllClick;

  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-foreground [&_svg]:text-foreground">
            {icon}
          </div>
        )}
        <h2 className="text-fluid-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h2>
      </div>
      {showSeeAll &&
        (onSeeAllClick ? (
          <button
            onClick={onSeeAllClick}
            className="group inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            See All
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
        ) : (
          <Link
            href={seeAllHref!}
            className="group inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            See All
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Link>
        ))}
    </div>
  );
}
