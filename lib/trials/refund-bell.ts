import type { Tx } from "@/lib/prisma";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBell } from "@/lib/novu/stage-bell";

/** The learner hears their paid trial was refunded (#1775 C-12). */
export function stageTrialRefundedBell(
  tx: Pick<Tx, "notificationOutbox">,
  trial: {
    id: string;
    consulteeUserId: string;
    planTitle: string;
    consultantName: string | null;
  },
) {
  return stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.TRIAL_REFUNDED,
    recipients: [trial.consulteeUserId],
    payload: {
      planTitle: trial.planTitle,
      consultantName: trial.consultantName ?? "The consultant",
      dashboardUrl: "/dashboard",
    },
    dedupeKey: `trial-refund:${trial.id}`,
  });
}
