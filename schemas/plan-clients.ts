import { z } from "zod";

/** The limit's accepted range; the ceiling only keeps a typo inside the Int column. */
export const MAX_ACTIVE_PLAN_CLIENTS_RANGE = { min: 1, max: 500 } as const;

/** The expert's limit on live 1:1 plan clients: a whole number in range, or null for none. */
export const maxActivePlanClientsSchema = z
  .number()
  .int()
  .min(MAX_ACTIVE_PLAN_CLIENTS_RANGE.min)
  .max(MAX_ACTIVE_PLAN_CLIENTS_RANGE.max)
  .nullable();

/** The owner-only read behind "3 of 5 active plan clients" (`GET /api/user/consultants/[id]/plan-clients`). */
export const planClientsReadSchema = z.object({
  activePlanClients: z.number().int().nonnegative(),
  maxActivePlanClients: maxActivePlanClientsSchema,
});

export type PlanClientsRead = z.infer<typeof planClientsReadSchema>;
