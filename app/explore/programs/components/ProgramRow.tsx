"use client";

import { memo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Program } from "@/lib/explore/programs";
import ProgramCard, { ProgramBadge } from "./ProgramCard";

interface ProgramRowProps {
  programs: Program[];
  badge?: ProgramBadge;
  isLoading?: boolean;
}

function SkeletonCard() {
  return (
    <div className="flex-shrink-0 w-[320px] md:w-[360px] rounded-2xl border border-border overflow-hidden">
      <div className="aspect-[16/10] bg-muted animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-5 bg-muted rounded animate-pulse w-3/4" />
        <div className="h-4 bg-muted rounded animate-pulse w-full" />
        <div className="h-5 bg-muted rounded animate-pulse w-1/4" />
      </div>
    </div>
  );
}

function ProgramRowImpl({ programs, badge, isLoading }: ProgramRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const amount = 380;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  if (isLoading) {
    return (
      <div className="flex gap-5 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (programs.length === 0) return null;

  return (
    <div className="relative group/row">
      {/* Scroll buttons */}
      <button
        onClick={() => scroll("left")}
        className="absolute left-0 top-1/2 z-10 flex h-10 w-10 -translate-x-2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card shadow-lg transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:-translate-x-4 md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
        aria-label="Scroll left"
      >
        <ChevronLeft className="w-5 h-5 text-muted-foreground" />
      </button>
      <button
        onClick={() => scroll("right")}
        className="absolute right-0 top-1/2 z-10 flex h-10 w-10 translate-x-2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card shadow-lg transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:translate-x-4 md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100"
        aria-label="Scroll right"
      >
        <ChevronRight className="w-5 h-5 text-muted-foreground" />
      </button>

      {/* Scrollable row */}
      <div
        ref={scrollRef}
        className="flex gap-5 overflow-x-auto scrollbar-hide pb-2"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {programs.map((program) => (
          <ProgramCard
            key={program.id}
            program={program}
            variant="carousel"
            badge={badge}
          />
        ))}
      </div>
    </div>
  );
}

const ProgramRow = memo(ProgramRowImpl);
export default ProgramRow;
