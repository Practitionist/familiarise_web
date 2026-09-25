import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { expireUnallocatedPaidSubscriptionForOne } from "@/scripts/appointments/expire-stale-requests";

/** #1771 K-6 — run the 48 h unallocated arm for one paid plan, now. */
export const POST = withOpsAction(
  "classSeries.money",
  "sweep.unallocated-48h",
  { subscriptionId: z.string().min(1) },
  {
    mode: "gateway",
    target: ({ body }) => ({ kind: "Subscription", id: body.subscriptionId }),
    run: async ({ body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const result = await expireUnallocatedPaidSubscriptionForOne(
        body.subscriptionId,
      );
      return {
        target: { kind: "Subscription", id: body.subscriptionId },
        after: {
          expired: result.expired,
          issued: result.issued,
          failures: result.failures,
        },
        response: { result },
      };
    },
  },
);
