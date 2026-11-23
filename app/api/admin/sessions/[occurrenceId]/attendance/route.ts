import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { rereadSessionAttendance } from "@/lib/backoffice/session-outcomes";

/**
 * Read Stream's participant record of one past session again and store it, as
 * the outcome sweep would; answers the verdict it gives without applying it.
 */
export const POST = withOpsAction(
  "classSeries.support",
  "session.reread-attendance",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "AppointmentOccurrence",
      id: params.occurrenceId,
    }),
    run: async ({ params }) => {
      const occurrenceId = params.occurrenceId;
      const reread = await rereadSessionAttendance({ occurrenceId });
      return {
        target: { kind: "AppointmentOccurrence", id: occurrenceId },
        correlationId: `session:${occurrenceId}`,
        after: reread,
        response: reread,
      };
    },
  },
);
