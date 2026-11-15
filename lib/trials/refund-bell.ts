import type { Tx } from "@/lib/prisma";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBell } from "@/lib/novu/stage-bell";
import { goHref } from "@/lib/dashboard/go";
import type { RequiredNoticeKind } from "@/lib/notifications/required-notices";

/** The learner hears their paid trial was refunded (#1775 C-12). */
export function stageTrialRefundedBell(
  tx: Pick<Tx, "notificationOutbox">,
  trial: {
    id: string;
    consulteeUserId: string;
    planTitle: string;
    consultantName: string | null;
    /** The cancel came from the expert or staff, so the bell skips the learner's switches. */
    required?: RequiredNoticeKind;
  },
) {
  return stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.TRIAL_REFUNDED,
    recipients: [trial.consulteeUserId],
    payload: {
      planTitle: trial.planTitle,
      consultantName: trial.consultantName ?? "The consultant",
      // #1527 — the recipient is always the consultee (the learner).
      dashboardUrl: goHref("client", "payments"),
    },
    dedupeKey: `trial-refund:${trial.id}`,
    ...(trial.required ? { required: trial.required } : {}),
  });
}
