"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/utils/tailwind";

/**
 * One horizontal rail, instead of two.
 *
 * `ExpertRow` and `ProgramRow` were 89 and 91 lines and the same component
 * with different numbers: scroll step 280 vs 380, card width `w-[260px]` vs
 * `w-[320px] md:w-[360px]`, gap `gap-4` vs `gap-5`, four skeletons vs five.
 * The arrow-button class strings were character-for-character identical.
 *
 * Two fixes folded in while merging:
 *
 *  - The arrows were `opacity-0` until the rail was hovered, which meant a
 *    keyboard user tabbing into the rail had no visible way to scroll it. The
 *    trigger is now a real button that is always in the tab order and
 *    revealed on focus as well as on hover.
 *  - `scrollbarWidth: none` plus the `scrollbar-hide` class removed the
 *    scrollbar without removing scrollability, leaving no affordance at all on
 *    touch. The rail still hides it (a 4px bar between cards is noise) but the
 *    edge gradient below marks the overflow.
 */
export function HorizontalRow({
  children,
  heading,
  headerAction,
  className,
  label,
}: {
  children: React.ReactNode;
  heading?: React.ReactNode;
  headerAction?: React.ReactNode;
  className?: string;
  /**
   * Names the scroll region for assistive tech. There is deliberately NO
   * `cardWidth` prop: the card sets its own width, and the scroll step is
   * measured from the first child at press time, so a number passed in here
   * could only ever disagree with the thing it was meant to describe.
   */
  label?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const syncEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    syncEdges();
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(syncEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncEdges]);

  const scrollBy = (direction: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    // A card plus its gap, so one press moves exactly one card rather than an
    // arbitrary amount that leaves a card half-visible.
    const card = el.firstElementChild as HTMLElement | null;
    const step = card ? card.offsetWidth + 16 : el.clientWidth * 0.8;
    el.scrollBy({ left: direction * step, behavior: "smooth" });
  };

  return (
    <section className={className}>
      {heading && (
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
            {heading}
          </h2>
          {headerAction}
        </div>
      )}

      {/* `group/rail` is what the arrows key their hover reveal off. */}
      <div className="group/rail relative">
        <RailArrow
          side="left"
          hidden={atStart}
          onClick={() => scrollBy(-1)}
        />
        <div
          ref={scrollerRef}
          onScroll={syncEdges}
          // A scroll region is a landmark-ish thing to a screen reader; the
          // label is what tells them what they have landed in.
          role="region"
          aria-label={label ?? (typeof heading === "string" ? heading : undefined)}
          tabIndex={0}
          className={cn(
            "flex snap-x snap-mandatory gap-4 overflow-x-auto scrollbar-hide pb-2",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
          )}
        >
          {children}
        </div>
        <RailArrow side="right" hidden={atEnd} onClick={() => scrollBy(1)} />
      </div>
    </section>
  );
}

function RailArrow({
  side,
  hidden,
  onClick,
}: {
  side: "left" | "right";
  hidden: boolean;
  onClick: () => void;
}) {
  if (hidden) return null;
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Scroll left" : "Scroll right"}
      className={cn(
        "absolute top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center",
        "rounded-full border border-border bg-card/90 text-foreground shadow-elevation-2 backdrop-blur",
        "transition-[opacity,background-color] hover:bg-card",
        "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "md:flex",
        // `opacity-0` only until hover OR focus, so a keyboard user discovers
        // the control — the previous version never revealed it to them.
        "opacity-0 focus-visible:opacity-100 group-hover/rail:opacity-100",
        side === "left" ? "-left-3" : "-right-3",
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

/** Placeholder matching the real card's footprint. */
export function HorizontalRowSkeleton({
  count = 5,
  cardWidth = "w-[260px]",
}: {
  count?: number;
  cardWidth?: string;
}) {
  return (
    <div className="flex gap-4 overflow-hidden pb-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={cn("shrink-0 snap-start", cardWidth)}
        >
          <div className="h-[220px] animate-pulse rounded-card border border-border bg-card" />
        </div>
      ))}
    </div>
  );
}
