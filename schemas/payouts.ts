// schemas/payouts.ts
import { z } from "zod";

/** POST /api/admin/payouts — batch creation moves real money, so the id
 *  list is closed-shape: a non-empty array of id strings, capped so one
 *  request cannot enqueue an unbounded batch. */
export const adminPayoutBatchSchema = z.object({
  consultantProfileIds: z.array(z.string().min(1).max(128)).min(1).max(200),
});

export type AdminPayoutBatchInput = z.infer<typeof adminPayoutBatchSchema>;

/** GET /api/admin/payouts — filter/pagination bounds. `limit`/`offset` were
 *  raw parseInt (NaN-able); status/search/orgId are bounded passthroughs. */
export const adminPayoutsQuerySchema = z.object({
  status: z.string().max(64).nullish(),
  search: z.string().max(200).nullish(),
  orgId: z.string().max(128).nullish(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type AdminPayoutsQuery = z.infer<typeof adminPayoutsQuerySchema>;

/** PATCH /api/consultant/payout-accounts/[id] — only two mutations exist
 *  (reverify, set-default); unknown keys are stripped, wrong types 400. */
export const payoutAccountPatchSchema = z.object({
  action: z.enum(["reverify"]).optional(),
  isDefault: z.boolean().optional(),
});

export type PayoutAccountPatchInput = z.infer<typeof payoutAccountPatchSchema>;
