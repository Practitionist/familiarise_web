import { z } from "zod";

/** The buyer-facing feasibility read (`GET /api/plans/subscriptions/[id]/feasibility`). */
export const planFeasibilitySchema = z.object({
  verdict: z.enum(["impossible", "tight", "ok"]),
  firstWeekPlaceable: z.number().int().nonnegative(),
  sessionsPerWeek: z.number().int().positive(),
  notice: z.string().nullable(),
  /** The expert's plan-client limit turns this buyer away; never the limit itself. */
  fullyBooked: z.boolean(),
  /** The expert's scheduling zone, which the server cuts the first cycle in. */
  zone: z.string().min(1),
});

export type PlanFeasibility = z.infer<typeof planFeasibilitySchema>;

/** The NOT_PLACEABLE sentence: the checkout banner and the server refusal share it. */
export const NOT_PLACEABLE_MESSAGE =
  "This expert has no free time in the first week of this plan right now. Pick a later start date, or ask them to open more hours.";

/**
 * Checkout's pay button is off when the server's read turns this viewer away
 * (fully booked) or finds no free time in the first week (NOT_PLACEABLE).
 */
export function subscriptionCheckoutBlocked(
  feasibility: PlanFeasibility | null,
): boolean {
  return (
    feasibility?.fullyBooked === true || feasibility?.firstWeekPlaceable === 0
  );
}

/** The disabled pay button's label, naming which of the two blocks applies. */
export function subscriptionCheckoutBlockedLabel(
  feasibility: PlanFeasibility | null,
): string {
  return feasibility?.fullyBooked === true
    ? "Fully booked"
    : "No free time in the first week";
}
