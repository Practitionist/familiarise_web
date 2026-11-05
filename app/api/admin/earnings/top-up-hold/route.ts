import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { releaseTopUpHold } from "@/lib/backoffice/top-up-hold";

/**
 * Release one held top-up's OPERATOR hold once the top-up is paid: only that
 * hold, so another top-up's hold on the same earnings stays until it is paid.
 */
export const POST = withOpsAction(
  "payouts.manage",
  "earnings.release-top-up",
  { correlationId: z.string().min(1).max(500) },
  {
    mode: "tx",
    run: async (tx, { body, actor }) => {
      const { paymentId, released } = await releaseTopUpHold(
        tx,
        body.correlationId,
        actor.userId,
      );
      return {
        target: { kind: "Payment", id: paymentId },
        after: { correlationId: body.correlationId, released },
        response: { released },
      };
    },
  },
);
