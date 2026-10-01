import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { hostedForClass } from "@/lib/backoffice/class-doors";
import { cancelClassSession } from "@/lib/booking/class-sessions";

/** #1771 K-6 — cancel one future session on the host's behalf (a miss). */
export const POST = withOpsAction(
  "classSeries.support",
  "class.cancel-session",
  { occurrenceId: z.string().min(1) },
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "AppointmentOccurrence",
      id: body.occurrenceId,
    }),
    run: async ({ params, body, actor }) => {
      const hosted = await hostedForClass(params.classId, actor.userId);
      const result = await cancelClassSession(hosted, body.occurrenceId);
      return {
        target: { kind: "AppointmentOccurrence", id: body.occurrenceId },
        correlationId: `class:${params.classId}`,
        after: {
          misses: result.misses,
          exitRight: result.exitRight,
          makeUpBy: result.makeUpBy.toISOString(),
        },
        response: { result },
      };
    },
  },
);
