import { z } from "zod";

/** The buyer-facing feasibility read (`GET /api/plans/subscriptions/[id]/feasibility`). */
export const planFeasibilitySchema = z.object({
  verdict: z.enum(["impossible", "tight", "ok"]),
  firstWeekPlaceable: z.number().int().nonnegative(),
  sessionsPerWeek: z.number().int().positive(),
  notice: z.string().nullable(),
  /** The expert's plan-client limit turns this buyer away; never the limit itself. */
  fullyBooked: z.boolean(),
});

export type PlanFeasibility = z.infer<typeof planFeasibilitySchema>;
