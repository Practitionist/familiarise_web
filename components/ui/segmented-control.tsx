"use client";

import * as React from "react";

import { cn } from "@/utils/tailwind";

/**
 * One segmented control, instead of four.
 *
 * The same pattern was written four times across the explore surfaces and the
 * expert profile, with four different implementations:
 *
 *   - `ProgramTabs`      — no roles, no `aria-pressed`, active state only visual
 *   - `StickyFilterBar`  — `role="group"` + `aria-pressed` (the correct one)
 *   - `ExpertPricing`    — a dark pill with a framer-motion `layoutId` spring
 *   - `ClassesAndWebinars` — a light pill with a `layoutId` spring
 *
 * The two `layoutId` versions existed only to animate the sliding thumb, which
 * `SegmentedThumb` does with a CSS transition and no per-call-site motion
 * plumbing — and without needing framer-motion mounted for it.
 *
 * Semantics: a set of buttons that filter or switch a view is a **group of
 * toggles**, not a tablist. `role="tablist"` would promise the arrow-key
 * roving-focus behaviour and the `tabpanel` association that these do not
 * have, so a screen-reader user would be told to expect something the markup
 * does not deliver. `aria-pressed` on each button is the accurate signal.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Visually hidden suffix, e.g. a result count announced but not shown. */
  srSuffix?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  label,
  size = "md",
  fullWidth = false,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** Names the group for assistive tech. Required — an unnamed group of
   *  toggles is announced as a bare row of buttons. */
  label: string;
  size?: "sm" | "md";
  fullWidth?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "relative inline-flex items-center gap-0.5 rounded-control border border-border bg-muted p-1",
        fullWidth && "flex w-full",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            // `aria-pressed` is the whole point: it is what the ProgramTabs
            // version omitted, leaving a control that looked like a tablist
            // and announced as nothing.
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[0.3125rem] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "disabled:pointer-events-none disabled:opacity-50",
              size === "sm"
                ? "h-7 px-2.5 text-xs"
                : "h-8 px-3 text-sm",
              active
                ? "bg-card text-foreground shadow-elevation-1 shadow-edge"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.srSuffix && <span className="sr-only">{option.srSuffix}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A hairline rule styled as a section divider.
 *
 * Not a wrapper — a single element, so it cannot be mis-nested. Used where the
 * old code reached for a `<div className="border-b">` inside a flex parent and
 * got a full-width rule that fought the gutter.
 */
export function Divider({
  className,
  orientation = "horizontal",
}: {
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
    />
  );
}
