import type { PrismaLike } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import { stageClawbackNoticeEmail } from "@/lib/email/senders/money";
import { formatNotificationMoney } from "@/lib/novu/humanize";
import { rosterForOrg, VISIBILITY_ROLES } from "@/lib/novu/org-workflows";
import { stageBell } from "@/lib/novu/stage-bell";
import {
  NOVU_WORKFLOWS,
  type ClawbackNoticeEvent,
  type PayoutClawbackPayload,
} from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";
import type { ClawbackPayee } from "./clawback-recovery";

/**
 * Stages the payee's clawback notice in the transaction that posted `journalId`;
 * call it only for a newly created journal. Only a raised debt also emails.
 */
export async function stageClawbackNotice(
  db: PrismaLike,
  input: {
    payee: ClawbackPayee;
    payoutId: string;
    journalId: string;
    event: ClawbackNoticeEvent;
    amountPaise: number;
  },
): Promise<void> {
  if (input.amountPaise <= 0) return;
  const org = input.payee.rail === "ORG";
  let recipients: string[];
  let dashboardUrl: string;
  if (input.payee.rail === "ORG") {
    recipients = await rosterForOrg(
      input.payee.organizationId,
      VISIBILITY_ROLES,
      db,
    );
    dashboardUrl = `${getAppUrl()}/dashboard/organization/${input.payee.organizationId}/payouts`;
  } else {
    const consultant = await db.consultantProfile.findUnique({
      where: { id: input.payee.consultantProfileId },
      select: { userId: true },
    });
    recipients = consultant ? [consultant.userId] : [];
    dashboardUrl = `${getAppUrl()}${goHref("expert", "earnings")}`;
  }
  if (recipients.length === 0) return;
  const payload: PayoutClawbackPayload = {
    eventKind: input.event,
    amount: formatNotificationMoney(input.amountPaise, "INR"),
    payoutId: input.payoutId,
    dashboardUrl,
  };
  await stageBell(db, {
    workflowId: org
      ? NOVU_WORKFLOWS.ORG_PAYOUT_CLAWBACK
      : NOVU_WORKFLOWS.PAYOUT_CLAWBACK,
    recipients,
    payload,
    dedupeKey: `clawback:${input.journalId}`,
    entityRef: `payout:${input.payoutId}`,
  });
  if (input.event !== "RAISED") return;
  await stageClawbackNoticeEmail(db, {
    recipientUserIds: recipients,
    organization: org,
    payoutId: input.payoutId,
    journalId: input.journalId,
    amountPaise: input.amountPaise,
    dashboardUrl,
  });
}
