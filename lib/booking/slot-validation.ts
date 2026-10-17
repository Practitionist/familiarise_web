import { BookingRuleError } from "./booking-rule-error";

/** How long a booked window must be: hours on a 1:1 plan, minutes on a trial. */
export type PlanDuration =
  { durationInHours: number | null } | { trialDurationMinutes: number };

function planDurationLabel(plan: PlanDuration): string {
  return "trialDurationMinutes" in plan
    ? `${plan.trialDurationMinutes} minutes`
    : `${plan.durationInHours} hour(s)`;
}

function planDurationMs(plan: PlanDuration): number | null {
  const ms =
    "trialDurationMinutes" in plan
      ? plan.trialDurationMinutes * 60_000
      : (plan.durationInHours ?? 0) * 3_600_000;
  return ms > 0 ? Math.round(ms) : null;
}

/** A window is sold only at the plan's own length; an unreadable window never matches. */
export function assertWindowMatchesPlanDuration(
  plan: PlanDuration,
  startsAt: Date | string,
  endsAt: Date | string,
): void {
  const expectedMs = planDurationMs(plan);
  if (expectedMs === null) return;
  const actualMs = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  if (actualMs !== expectedMs) {
    throw new BookingRuleError(
      "WINDOW_DURATION_MISMATCH",
      `The selected time must match the plan length (${planDurationLabel(plan)}).`,
      400,
    );
  }
}
