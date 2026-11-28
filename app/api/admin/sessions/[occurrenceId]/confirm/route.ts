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
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      const occurrenceId = params.occurrenceId;
      const result = await confirmSessionOutcome(tx, {
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
        afterCommit: result.afterCommit,
      };
    },
  },
);
