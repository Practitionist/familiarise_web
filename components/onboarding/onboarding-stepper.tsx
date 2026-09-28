"use client";

/**
 * Onboarding progress stepper.
 *
 * Replaces the inline stepper that used to live in `app/form/onboarding/page.tsx`,
 * which had four defects worth naming because they are easy to reintroduce:
 *
 *  1. The connector `<li>`s were SIBLINGS of the step `<li>`s inside the same
 *     `<ol>`, so assistive tech announced `2N - 1` list items for an N-step
 *     flow — 9 items for a 5-step wizard. Connectors here are non-`<li>`
 *     elements inside each step's own `<li>`, so the count is always N.
 *  2. The current step was rendered as `disabled`, which removes it from the
 *     tab order and from the accessibility tree's focus ring, while still
 *     carrying `aria-current="step"`. It is a `<span>` here instead: it is not
 *     interactive, so it should not be focusable or activatable.
 *  3. Labels were `truncate`d at `max-w-[80px]` AND `aria-hidden`, so
 *     "Agreement & Verification" rendered as "Agreement & Ve…" with no
 *     tooltip. Labels now wrap, and the dots carry a full `aria-label` so
 *     nothing is lost when the visual label is hidden on small screens.
 *  4. There was no percentage and no progress bar, only "Step 2 of 5" in the
 *     page header. Research on wizard completion is consistent that people
 *     need both the position and the proportion remaining.
 *
 * Colours are token-only (`bg-primary`, `border-border`, `text-muted-foreground`).
 * The route mounts this inside a `.dark` scope, so every one of those resolves
 * to its dark value with no `dark:` variant written here.
 */

import { Progress } from "@/components/ui/progress";
import { indicatorTransition } from "@/lib/motion";
import { cn } from "@/utils/tailwind";
import { Check } from "lucide-react";
import { motion } from "framer-motion";

export interface OnboardingStepperStep {
  /** Stable key from the wizard's step registry. */
  key: string;
  label: string;
}

interface OnboardingStepperProps {
  steps: OnboardingStepperStep[];
  /** Zero-based index of the active step. */
  current: number;
  /** Going back to an already-completed step. */
  onGoToStep?: (index: number) => void;
  className?: string;
}

export function OnboardingStepper({
  steps,
  current,
  onGoToStep,
  className,
}: OnboardingStepperProps) {
  const total = steps.length;
  // A single-step flow has nothing to progress through; showing "100%"
  // before the user has done anything would be a lie.
  const percent = total <= 1 ? 0 : Math.round((current / (total - 1)) * 100);

  return (
    <nav aria-label="Onboarding steps" className={cn("w-full", className)}>
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Step {current + 1} of {total}
        </span>
        {total > 1 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {percent}% complete
          </span>
        )}
      </div>

      <Progress value={percent} className="h-[3px]" />

      <ol className="mt-5 flex items-start">
        {steps.map((step, index) => {
          const isCurrent = index === current;
          const isDone = index < current;
          const canGoBack = isDone && typeof onGoToStep === "function";

          return (
            <li
              key={step.key}
              className="relative flex min-w-0 flex-1 flex-col items-center gap-2"
            >
              {/* Connector to the NEXT step. Lives inside this step's <li> and
                  is not itself a list item, so the <ol> reports exactly one
                  item per step. aria-hidden: it carries no information a
                  screen reader needs — the count is on each dot. */}
              {index < total - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-[1.0625rem] left-[calc(50%+1.375rem)] h-0.5 w-[calc(100%-2.75rem)] rounded-full transition-colors duration-500",
                    isDone ? "bg-primary" : "bg-muted-foreground/20",
                  )}
                />
              )}

              {canGoBack ? (
                <button
                  type="button"
                  onClick={() => onGoToStep?.(index)}
                  aria-label={`Step ${index + 1} of ${total}: ${step.label} (completed, go back)`}
                  className={cn(
                    "flex h-9 w-9 flex-none items-center justify-center rounded-full border-2 bg-primary text-sm font-medium text-primary-foreground transition-shadow",
                    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40",
                    "hover:ring-4 hover:ring-primary/20",
                  )}
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : (
                <span
                  // A plain <span>, not a button: the current and upcoming
                  // steps are not interactive, so they must not be focusable
                  // or activatable. `relative` so the travelling ring can sit
                  // behind the number.
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "relative flex h-9 w-9 flex-none items-center justify-center rounded-full border-2 text-sm font-medium",
                    isCurrent
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/30 text-muted-foreground",
                  )}
                >
                  {/* One travelling indicator rather than a ring that blinks
                      on and off as `current` moves between steps. */}
                  {isCurrent && (
                    <motion.span
                      layoutId="onboarding-step-indicator"
                      transition={indicatorTransition}
                      className="absolute inset-0 rounded-full ring-4 ring-primary/20"
                      aria-hidden="true"
                    />
                  )}
                  {/* The number is decorative: position in the <ol> already
                      conveys order, and the label carries the name. */}
                  <span aria-hidden="true">{index + 1}</span>
                </span>
              )}

              {/* `sr-only` below sm rather than `hidden`: the visual label is
                  dropped on narrow screens, but it stays in the accessibility
                  tree so a list item always reads as "Personal Info" rather
                  than a bare "1". */}
              <span
                className={cn(
                  "max-w-[7.5rem] text-center text-xs leading-tight",
                  "sr-only sm:not-sr-only",
                  index <= current
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
