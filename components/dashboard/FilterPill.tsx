"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/tailwind";

/** Classes for the menu trigger inside a `FilterPill`. */
export function filterTriggerClass(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-l-[inherit] transition-colors focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none",
    active ? "pl-3 pr-1.5" : "rounded-r-[inherit] px-3",
  );
}

interface FilterPillProps {
  /** A filter is applied: the outline darkens and the clear button shows. */
  active: boolean;
  disabled?: boolean;
  /** The clear button's accessible name, e.g. "Clear date filter". */
  clearLabel: string;
  onClear: () => void;
  /** The popover whose trigger uses `filterTriggerClass`. */
  children: ReactNode;
}

/**
 * The box around a filter's menu trigger and its clear button. One border and
 * one focus ring wrap both, so they read as a single control the height of the
 * search field (a button cannot nest in a button, hence the siblings).
 */
export function FilterPill({
  active,
  disabled = false,
  clearLabel,
  onClear,
  children,
}: Readonly<FilterPillProps>) {
  return (
    <div
      className={cn(
        "inline-flex h-9 items-stretch rounded-md border bg-card text-sm font-medium text-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        active
          ? "border-foreground"
          : "border-border hover:border-foreground/30",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {children}
      {active && (
        <button
          type="button"
          aria-label={clearLabel}
          disabled={disabled}
          onClick={onClear}
          className="inline-flex items-center rounded-r-[inherit] pl-1 pr-2.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
