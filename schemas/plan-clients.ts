import { z } from "zod";

/** The limit's accepted range; the ceiling only keeps a typo inside the Int column. */
export const MAX_ACTIVE_PLAN_CLIENTS_RANGE = { min: 1, max: 500 } as const;

const LIMIT_RULE =
  "Enter a whole number from 1 to 500, or leave it blank for no limit.";

/** The expert's limit on live 1:1 plan clients: a whole number in range, or null for none. */
export const maxActivePlanClientsSchema = z
  .number({ invalid_type_error: LIMIT_RULE })
  .int({ message: `Use a whole number of clients. ${LIMIT_RULE}` })
  .min(MAX_ACTIVE_PLAN_CLIENTS_RANGE.min, {
    message: `The limit must be at least 1. ${LIMIT_RULE}`,
  })
  .max(MAX_ACTIVE_PLAN_CLIENTS_RANGE.max, {
    message: `The limit can be at most 500. ${LIMIT_RULE}`,
  })
  .nullable();

/** What the expert typed, checked by the route's own schema: blank is no limit; never altered. */
export function parsePlanClientLimitInput(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const typed = raw.trim();
  const parsed = maxActivePlanClientsSchema.safeParse(
    typed === "" ? null : Number(typed),
  );
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues[0]?.message ?? LIMIT_RULE };
}

/** The owner-only read behind "3 of 5 active plan clients" (`GET /api/user/consultants/[id]/plan-clients`). */
export const planClientsReadSchema = z.object({
  activePlanClients: z.number().int().nonnegative(),
  maxActivePlanClients: maxActivePlanClientsSchema,
});

export type PlanClientsRead = z.infer<typeof planClientsReadSchema>;

/** The signed-in viewer's own answer: they already hold one of this expert's plans. */
export const viewerPlanClientSchema = z.object({ holdsPlan: z.boolean() });

export type ViewerPlanClient = z.infer<typeof viewerPlanClientSchema>;
