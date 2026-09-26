"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";

export interface BulkBarProps {
  count: number;
  /** Overrides the "N selected" line, e.g. a progress message while running. */
  status?: ReactNode;
  onClear?: () => void;
  /** Disables Clear while a bulk action runs. */
  busy?: boolean;
  /** The bulk actions. */
  children?: ReactNode;
  /** Anything under the bar, e.g. per-row outcomes. */
  footer?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * The sticky bar a selectable list shows while rows are selected (#1527),
 * lifted from the Requests inbox's BatchApproveBar look.
 */
export function BulkBar({
  count,
  status,
  onClear,
  busy = false,
  children,
  footer,
  className,
  "aria-label": ariaLabel = "Bulk actions",
}: Readonly<BulkBarProps>) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn(
        "sticky bottom-0 z-10 mt-4 rounded-lg border border-border bg-background/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground" aria-live="polite">
          {status ?? `${count} selected`}
        </p>
        <div className="flex items-center gap-2">
          {onClear && (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-8"
              disabled={busy}
              onClick={onClear}
            >
              Clear
            </Button>
          )}
          {children}
        </div>
      </div>
      {footer}
    </section>
  );
}
