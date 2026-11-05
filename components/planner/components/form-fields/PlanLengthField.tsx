"use client";

/**
 * A 1:1 plan's length. A weeks plan picks a preset or 1–52 custom weeks, and
 * its months label follows; a plan sold in months keeps its months field.
 */

import {
  useController,
  useWatch,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FormDescription,
  FormItem,
  FormLabel,
  FormMessage,
  RequiredMark,
} from "@/components/ui/form";
import { monthsForWeeks, planLengthLabel } from "@/lib/booking/entitlement";

export const PLAN_WEEK_PRESETS: readonly number[] = [4, 8, 12, 26, 52];
export const MAX_PLAN_WEEKS = 52;

/** "26 weeks · 78 sessions" for a valid length, else null. */
function lengthSummary(
  weeks: unknown,
  months: unknown,
  perWeek: number,
): string | null {
  if (typeof weeks === "number") {
    if (!(weeks >= 1 && weeks <= MAX_PLAN_WEEKS)) return null;
    return planLengthLabel({
      durationInWeeks: weeks,
      durationInMonths: monthsForWeeks(weeks),
      sessionsPerWeek: perWeek,
    });
  }
  if (typeof months !== "number" || months < 1) return null;
  return planLengthLabel({
    durationInWeeks: null,
    durationInMonths: months,
    sessionsPerWeek: perWeek,
  });
}

interface PlanLengthFieldProps<T extends FieldValues = FieldValues> {
  control: Control<T>;
  required?: boolean;
}

export function PlanLengthField<T extends FieldValues = FieldValues>({
  control,
  required,
}: Readonly<PlanLengthFieldProps<T>>) {
  const {
    field: weeksField,
    fieldState: { error: weeksError },
  } = useController({ name: "durationInWeeks" as FieldPath<T>, control });
  const {
    field: monthsField,
    fieldState: { error: monthsError },
  } = useController({ name: "durationInMonths" as FieldPath<T>, control });
  const perWeekValue: unknown = useWatch({
    control,
    name: "sessionsPerWeek" as FieldPath<T>,
  });
  const perWeek =
    typeof perWeekValue === "number" && perWeekValue >= 1 ? perWeekValue : 1;
  const weeks: unknown = weeksField.value;
  const months: unknown = monthsField.value;
  // Null is a plan sold in months; a cleared custom box is NaN, still weeks.
  const inWeeks = typeof weeks === "number";

  const setWeeks = (next: number) => {
    weeksField.onChange(next);
    if (next >= 1 && next <= MAX_PLAN_WEEKS)
      monthsField.onChange(monthsForWeeks(next));
  };

  const summary = lengthSummary(weeks, months, perWeek);

  if (!inWeeks) {
    return (
      <FormItem>
        <FormLabel>
          Duration (months)
          {required && <RequiredMark />}
        </FormLabel>
        <Input
          type="number"
          min={1}
          max={24}
          step={1}
          name={monthsField.name}
          ref={monthsField.ref}
          onBlur={monthsField.onBlur}
          value={typeof months === "number" ? months : ""}
          onChange={(e) =>
            monthsField.onChange(
              e.target.value === ""
                ? undefined
                : Number.parseInt(e.target.value, 10),
            )
          }
        />
        <FormDescription>
          {summary ? `${summary}. ` : ""}This plan is sold in months; clients
          who already bought it keep their current terms.
        </FormDescription>
        {monthsError?.message && (
          <FormMessage>{monthsError.message}</FormMessage>
        )}
      </FormItem>
    );
  }

  const isPreset = PLAN_WEEK_PRESETS.includes(weeks);
  return (
    <FormItem>
      <FormLabel>
        Plan length
        {required && <RequiredMark />}
      </FormLabel>
      <div className="flex flex-wrap items-center gap-2">
        {PLAN_WEEK_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={weeks === preset ? "default" : "outline"}
            aria-pressed={weeks === preset}
            onClick={() => setWeeks(preset)}
          >
            {preset} weeks
          </Button>
        ))}
        <Input
          type="number"
          aria-label="Custom number of weeks"
          className="w-28"
          min={1}
          max={MAX_PLAN_WEEKS}
          step={1}
          placeholder="Custom"
          name={weeksField.name}
          ref={weeksField.ref}
          onBlur={weeksField.onBlur}
          value={isPreset || Number.isNaN(weeks) ? "" : weeks}
          onChange={(e) => setWeeks(Number.parseInt(e.target.value, 10))}
        />
      </div>
      <FormDescription>
        {summary ?? "Pick a length from 1 to 52 weeks."} The price is for the
        whole plan.
      </FormDescription>
      {weeksError?.message && <FormMessage>{weeksError.message}</FormMessage>}
    </FormItem>
  );
}
