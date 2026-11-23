import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { confirmSessionOutcome } from "@/lib/backoffice/session-outcomes";
import { NEGATIVE_MONEY_OUTCOMES } from "@/lib/booking/misses";

/**
 * Confirm one session's negative verdict as it stands; the body names the
 * outcome the operator saw, so a verdict changed since then is refused.
 */
export const POST = withOpsAction(
  "classSeries.support",
  "session.confirm-outcome",
  { outcome: z.enum(NEGATIVE_MONEY_OUTCOMES) },
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "AppointmentOccurrence",
      id: params.occurrenceId,
    }),
    run: async ({ params, body }) => {
      const occurrenceId = params.occurrenceId;
      const result = await confirmSessionOutcome({
        occurrenceId,
        outcome: body.outcome,
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
