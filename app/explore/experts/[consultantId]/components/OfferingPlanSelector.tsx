"use client";

import { useId } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { PricingOption } from "../defaults";

export function OfferingPlanSelector({
  options,
  value,
  onChange,
  label,
}: {
  options: PricingOption[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const id = useId();
  if (options.length < 2) return null;
  return (
    <RadioGroup value={value} onValueChange={onChange} aria-label={label}>
      {options.map((option) => (
        <label
          key={option.id}
          htmlFor={`${id}-${option.id}`}
          className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${value === option.id ? "border-foreground/40 bg-muted/60" : "border-border hover:bg-muted/40"}`}
        >
          <RadioGroupItem
            id={`${id}-${option.id}`}
            value={option.id}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{option.title}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {option.durationInMonths
                ? `${option.durationInMonths} months`
                : option.duration}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}
