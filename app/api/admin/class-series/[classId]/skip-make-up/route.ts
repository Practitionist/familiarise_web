import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { hostedForClass } from "@/lib/backoffice/class-doors";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { skipClassMakeUp } from "@/lib/booking/class-sessions";

/**
 * #1771 K-6 — skip a make-up for one learner: that session comes back as one
 * unit under the same key the day-14 sweep uses, so never twice. It refunds,
 * so it is an admin money door, not a staff support one.
 */
export const POST = withOpsAction(
  "classSeries.money",
  "class.skip-make-up",
  { occurrenceId: z.string().min(1), userId: z.string().min(1) },
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "AppointmentOccurrence",
      id: body.occurrenceId,
    }),
    run: async ({ params, body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const hosted = await hostedForClass(params.classId, actor.userId);
      const result = await skipClassMakeUp({
        appointmentId: hosted.appointment.id,
        sourceOccurrenceId: body.occurrenceId,
        userId: body.userId,
      });
      return {
        target: { kind: "AppointmentOccurrence", id: body.occurrenceId },
        correlationId: `class:${params.classId}`,
        after: { learnerUserId: body.userId, ...result },
        response: { result },
      };
    },
  },
);
