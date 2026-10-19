/**
 * POST /api/admin/payouts/process — disburse every APPROVED payout within a
 * request-bound run. ADMIN, step-up, a reason and an ops log row; the caller is
 * the disburser, so a payout they approved themselves is skipped (maker-checker).
 * A retry is safe: each payout leaves APPROVED through its own CAS claim.
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
      // #1846 N6 — a short lock and a run budget keep the payout lock from
      // outliving a Lambda killed at its limit; unstarted payouts stay APPROVED.
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
