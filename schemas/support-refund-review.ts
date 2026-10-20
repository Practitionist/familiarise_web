import { z } from "zod";

export const CaseRefundReviewSchema = z.object({
  action: z.literal("REVIEW_REFUND"),
  clientActionId: z.string().min(1).max(128),
  expectedUpdatedAt: z.string().datetime(),
  recommendationId: z.string().min(1).max(128),
  approve: z.boolean(),
  reason: z.string().trim().min(5).max(1000),
  expectedRefundablePaise: z.number().int().nonnegative().safe().optional(),
});
