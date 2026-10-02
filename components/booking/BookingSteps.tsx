"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { cn } from "@/utils/tailwind";

export function BookingSteps({
  steps,
  current,
}: Readonly<{ steps: string[]; current: number }>) {
  const heading = useRef<HTMLOListElement>(null);
  const previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) heading.current?.focus();
    previous.current = current;
  }, [current]);
  return (
    <ol
      ref={heading}
      tabIndex={-1}
      aria-label="Booking progress"
      className="flex flex-wrap justify-between gap-3 border-b border-border bg-muted/50 px-6 py-4 outline-none"
    >
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs sm:text-sm",
            index > current
              ? "text-muted-foreground"
              : "font-medium text-foreground",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
              index <= current
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background",
            )}
          >
            {index < current ? <Check className="h-3.5 w-3.5" /> : index + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}
