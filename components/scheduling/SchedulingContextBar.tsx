"use client";

import type { ReactNode } from "react";

import { cn } from "@/utils/tailwind";

/** One fact about what is being scheduled: "Week · 3 of 12". */
export interface ContextChip {
  key: string;
  label: string;
  value: string;
  /** The full sentence, for the hover title. */
  title?: string;
}

/**
 * One row of chips above the scheduling grid (plan cadence, plan week, plan
 * end, earliest start, display zone) in place of stacked banners, so the
 * grid keeps the height.
 */
export function SchedulingContextBar({
  chips,
  trailing,
  className,
}: Readonly<{
  chips: readonly ContextChip[];
  /** The zone line and its switch, at the end of the row. */
  trailing?: ReactNode;
  className?: string;
}>) {
  if (chips.length === 0 && !trailing) return null;
  return (
    <div
      data-testid="scheduling-context"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.title}
          className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs text-muted-foreground"
        >
          {chip.label}{" "}
          <span className="font-medium text-foreground">{chip.value}</span>
        </span>
      ))}
      {trailing}
    </div>
  );
}
