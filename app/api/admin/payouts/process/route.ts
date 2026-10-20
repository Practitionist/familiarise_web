/**
 * Admin disbursement requires a fresh session, a reason and an audit row.
 * Each payout is CAS-claimed and checked against its approving admin.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import {
  processApprovedPayouts,
  REQUEST_PAYOUT_RUN_BOUNDS,
} from "@/lib/payments/payouts";

export const POST = withOpsAction(
  "payouts.manage",
  "payout.process",
  {},
  {
    mode: "gateway",
    target: () => ({ kind: "PayoutRun", id: "approved" }),
    run: async ({ actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      // A bounded run and short lock leave unstarted payouts APPROVED if the request expires.
      const results = await processApprovedPayouts({
        ...REQUEST_PAYOUT_RUN_BOUNDS,
        triggeredByUserId: actor.userId,
      });
      const successful = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success).length;
      return {
        target: { kind: "PayoutRun", id: "approved" },
        after: { processed: results.length, successful, failed },
        response: {
          success: true,
          processed: results.length,
          successful,
          failed,
          results,
        },
      };
    },
  },
  { stepUp: true },
);
