import type { Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import { stageClawbackNoticeEmail } from "@/lib/email/senders/money";
import { formatNotificationMoney } from "@/lib/novu/humanize";
import { rosterForOrg, VISIBILITY_ROLES } from "@/lib/novu/org-workflows";
import { stageBells } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import type { ClawbackPayee } from "./clawback-recovery";

export type ClawbackNoticeEvent =
  "RAISED" | "OFFSET_RESERVED" | "OFFSET_RELEASED" | "VOIDED";

// Call only for a newly posted journal, inside the transaction that owns it.
export async function stageClawbackNotice(
  tx: Tx,
  input: {
    payee: ClawbackPayee;
    payoutId: string;
    journalId: string;
    event: ClawbackNoticeEvent;
    amountPaise: number;
  },
): Promise<void> {
  const org = input.payee.rail === "ORG";
  let recipients: string[];
  let dashboardUrl: string;
  if (input.payee.rail === "ORG") {
    recipients = await rosterForOrg(
      input.payee.organizationId,
      VISIBILITY_ROLES,
      tx,
    );
    dashboardUrl = `/dashboard/organization/${input.payee.organizationId}/payouts`;
  } else {
    const consultant = await tx.consultantProfile.findUnique({
      where: { id: input.payee.consultantProfileId },
      select: { userId: true },
    });
    if (!consultant) return;
    recipients = [consultant.userId];
    dashboardUrl = goHref("expert", "earnings");
  }
  await stageBells(tx, {
    workflowId: org
      ? NOVU_WORKFLOWS.ORG_PAYOUT_CLAWBACK
      : NOVU_WORKFLOWS.PAYOUT_CLAWBACK,
    recipients,
    dedupeKey: input.journalId,
    entityRef: `payout:${input.payoutId}`,
    payload: {
      payoutId: input.payoutId,
      eventKind: input.event,
      amount: formatNotificationMoney(input.amountPaise, "INR"),
      dashboardUrl,
    },
  });
  await stageClawbackNoticeEmail(tx, {
    ...input,
    recipientUserIds: recipients,
    organization: org,
    dashboardUrl,
  });
}
