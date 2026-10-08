"use client";

import type { RatingCause } from "@prisma/client";

export const RATING_CAUSE_OPTIONS: readonly {
  value: RatingCause;
  label: string;
}[] = [
  { value: "CONSULTANT", label: "Expert quality" },
  { value: "PLATFORM_TECHNICAL", label: "Audio / video quality" },
  { value: "SCHEDULING", label: "Timing / scheduling" },
  { value: "CONTENT", label: "Session content" },
  { value: "PAYMENT", label: "Billing / pricing" },
  { value: "OTHER", label: "Other" },
];

export function RatingCauseSelector({
  value,
  onChange,
  disabled = false,
  className,
}: Readonly<{
  value: RatingCause | null;
  onChange: (value: RatingCause | null) => void;
  disabled?: boolean;
  className?: string;
}>) {
  return (
    <fieldset className={className}>
      <legend className="text-xs text-muted-foreground mb-1.5">
        What could have gone better? (Optional)
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {RATING_CAUSE_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={(e) => {
                e.stopPropagation();
                onChange(selected ? null : option.value);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50 ${
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
