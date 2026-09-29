import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { hostedForClass } from "@/lib/backoffice/class-doors";
import { scheduleClassMakeUp } from "@/lib/booking/class-sessions";

/**
 * #1771 K-6 — grant a make-up for a host-cancelled session. `bypassWindow`
 * holds it past day 14, and the door's required reason is the bypass's too.
 */
export const POST = withOpsAction(
  "classSeries.support",
  "class.make-up",
  {
    occurrenceId: z.string().min(1),
    startsAt: z.coerce.date(),
    bypassWindow: z.boolean().default(false),
  },
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "AppointmentOccurrence",
      id: body.occurrenceId,
    }),
    run: async ({ params, body, actor }) => {
      const hosted = await hostedForClass(params.classId, actor.userId);
      const result = await scheduleClassMakeUp(
        hosted,
        body.occurrenceId,
        body.startsAt,
        body.bypassWindow
          ? {
              bypassWindow: {
                opsActorUserId: actor.userId,
                reason: body.reason,
              },
            }
          : {},
      );
      return {
        target: { kind: "AppointmentOccurrence", id: body.occurrenceId },
        correlationId: `class:${params.classId}`,
        after: {
          makeUpId: result.occurrenceId,
          startsAt: result.startsAt.toISOString(),
          bypassWindow: body.bypassWindow,
        },
        response: { result },
      };
    },
  },
);
