import { OccurrenceOutcome } from "@prisma/client";
import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { overturnSessionOutcome } from "@/lib/backoffice/session-outcomes";

/**
 * #1569 A-10 — overturn one past session's outcome (D7: a learner who could
 * not get in; an INCONCLUSIVE verdict decided by a human). Refused once a
 * void's make-up or refund has happened; runs under the appointment lock.
 */
export const POST = withOpsAction(
  "classSeries.support",
  "session.set-outcome",
  { outcome: z.nativeEnum(OccurrenceOutcome) },
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "AppointmentOccurrence",
      id: params.occurrenceId,
    }),
    run: async ({ params, body, actor }) => {
      const occurrenceId = params.occurrenceId;
      const result = await overturnSessionOutcome({
        occurrenceId,
        outcome: body.outcome,
        actorUserId: actor.userId,
      });
      return {
        target: { kind: "AppointmentOccurrence", id: occurrenceId },
        correlationId: `session:${occurrenceId}`,
        before: result.before,
        after: result.after,
        response: { result: result.after },
      };
    },
  },
);
