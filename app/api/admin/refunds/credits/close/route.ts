import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { closeCreditReturnWithoutCredit } from "@/lib/payments/operations/credit-plan-return";

/**
 * "No credit owed" for a credit plan's queued partial return: nothing goes
 * back to the buyer, and the plan's held-back earnings start their hold.
 */
export const POST = withOpsAction(
  "refunds.manage",
  "refund.credits.close",
  { paymentId: z.string().min(1) },
  {
    mode: "tx",
    run: async (tx, { body, actor }) => {
      const result = await closeCreditReturnWithoutCredit(tx, {
        paymentId: body.paymentId,
        initiatedByUserId: actor.userId,
        reason: body.reason,
      });
      return {
        target: { kind: "Payment", id: body.paymentId },
        after: result,
        response: { result },
      };
    },
  },
  { stepUp: true },
);
