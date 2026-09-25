import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { settleCancelledSessionForOne } from "@/scripts/appointments/settle-cancelled-sessions";

/** #1771 K-6 — run the 14-day make-up sweep for one host-cancelled session. */
export const POST = withOpsAction(
  "classSeries.money",
  "sweep.settle-session",
  { occurrenceId: z.string().min(1) },
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "AppointmentOccurrence",
      id: body.occurrenceId,
    }),
    run: async ({ body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const result = await settleCancelledSessionForOne(body.occurrenceId);
      return {
        target: { kind: "AppointmentOccurrence", id: body.occurrenceId },
        after: {
          scanned: result.scanned,
          stamped: result.stamped,
          refunded: result.refunded,
          errors: result.errors,
        },
        response: { result },
      };
    },
  },
);
