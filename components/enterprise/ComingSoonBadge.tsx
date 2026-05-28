"use client";

/**
 * #768 lockdown #23 — single source of truth for "Coming Soon" UI.
 *
 * Renders as a disabled control with a tooltip. Single component so we
 * can tweak copy and analytics in one place when v1.1 ships.
 */

import { cn } from "@/lib/utils";

export interface ComingSoonBadgeProps {
  feature: string;
  /** Optional override; defaults to a friendly v1.1 message. */
  message?: string;
  /** Use the inline variant inside a control (e.g., next to a button). */
  variant?: "inline" | "block";
}

const DEFAULT_MESSAGE = "Available in v1.1";

export function ComingSoonBadge({
  feature,
  message = DEFAULT_MESSAGE,
  variant = "inline",
}: ComingSoonBadgeProps) {
  return (
    <span
      data-feature={feature}
      title={`${message} — ${feature}`}
      aria-label={`Coming soon: ${feature}`}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5",
        "bg-amber-50 text-amber-800 border border-amber-200",
        variant === "block" && "px-3 py-1 text-sm",
      )}
    >
      <span
        aria-hidden="true"
        className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
      />
      {message}
    </span>
  );
}
