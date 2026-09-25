import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { restoreClassSeatCredits } from "@/lib/payments/operations/booking-refund";

/**
 * #1771 K-5 — "Return N sessions of credits" for a credit-funded class seat:
 * the credits rail restores whole or not at all, so partial returns are ops'.
 */
export const POST = withOpsAction(
  "refunds.manage",
  "refund.credits",
  {
    paymentId: z.string().min(1),
    sessions: z.number().int().min(1).max(500),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Payment", id: body.paymentId }),
    run: async ({ body, actor, opsActionId }) => {
      await assertMoneyOpsBudget(actor.userId);
      const result = await restoreClassSeatCredits({
        paymentId: body.paymentId,
        sessions: body.sessions,
        reason: `ops credit return: ${body.reason}`,
        initiatedByUserId: actor.userId,
        dedupeKey: `ops:${opsActionId}`,
      });
      return {
        target: { kind: "Payment", id: body.paymentId },
        after: { ...result, sessions: body.sessions },
        response: { result },
      };
    },
  },
);
