import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { getMaintenanceState } from "@/lib/maintenance";
import { settlePlatformIncidentForOne } from "@/scripts/appointments/settle-platform-incidents";

/** Runs the settle sweep for one incident now, under the sweep's own cron lock. */
export const POST = withOpsAction(
  "incidents.declare",
  "incident.settle",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "PlatformIncident",
      id: params.incidentId,
    }),
    run: async ({ params }) => {
      const { phase } = await getMaintenanceState();
      if (phase === "DEGRADED" || phase === "OFFLINE") {
        throw new OpsRefusal(
          "MAINTENANCE",
          "Money jobs are paused during maintenance.",
          503,
        );
      }
      const result = await settlePlatformIncidentForOne(params.incidentId);
      return {
        target: { kind: "PlatformIncident", id: params.incidentId },
        correlationId: `incident:${params.incidentId}`,
        after: {
          voided: result.voided,
          remediesDone: result.remediesDone,
          deadLettered: result.deadLettered,
          settled: result.settled,
        },
        response: { result },
      };
    },
  },
  { stepUp: true },
);
