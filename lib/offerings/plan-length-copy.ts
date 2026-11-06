/**
 * How checkout names a subscription plan's length and price: a weeks plan is
 * priced for the whole plan, a months plan per month.
 */

export interface PlanLengthCopyInput {
  durationInWeeks?: number | null;
  durationInMonths?: number | null;
}

const countOf = (n: number, unit: string) =>
  `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "1 week", "26 weeks", "1 month", "6 months". */
export function planDurationText(plan: PlanLengthCopyInput): string {
  return plan.durationInWeeks
    ? countOf(plan.durationInWeeks, "week")
    : countOf(plan.durationInMonths || 1, "month");
}

/** The pricing card's label for the plan's price. */
export function planPriceLabel(plan: PlanLengthCopyInput): string {
  return plan.durationInWeeks ? "Plan price" : "Monthly Fee";
}
