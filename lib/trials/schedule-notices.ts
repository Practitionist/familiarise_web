/**
 * The "trial scheduled" bell to each side and the email to both, staged on
 * the transaction that confirms the time, so a rollback takes them too. The
 * caller renders the email first (`prepareTrialScheduledEmail`) and flushes
 * the staged rows after the commit (`flushNotificationsAfter`).
 */
import { TrialStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import {
  stagePreparedEmails,
  type PreparedRecipientEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import { notifyTrialScheduled } from "@/lib/novu";

export interface StagedScheduleNotices {
  consulteeBell: Awaited<ReturnType<typeof notifyTrialScheduled>> | null;
  consultantBell: Awaited<ReturnType<typeof notifyTrialScheduled>> | null;
  emails: StagedRecipientEmail[];
}

export async function stageTrialScheduledNotices(
  tx: Tx,
  args: {
    trialId: string;
    consulteeUserId: string;
    consultantUserId: string;
    consulteeName: string;
    consultantName: string;
    planTitle: string;
    startsAt: Date;
    preparedEmails: PreparedRecipientEmails;
  },
): Promise<StagedScheduleNotices> {
  const payload = {
    consultantName: args.consultantName,
    consulteeName: args.consulteeName,
    planTitle: args.planTitle,
    dateTime: args.startsAt.toISOString(),
    status: TrialStatus.SCHEDULED,
  };
  const consulteeBell = await notifyTrialScheduled(
    args.consulteeUserId,
    { ...payload, dashboardUrl: goHref("client", "appointments") },
    { deferAttempt: true, tx },
  );
  const consultantBell = await notifyTrialScheduled(
    args.consultantUserId,
    { ...payload, dashboardUrl: goHref("expert", "appointments") },
    { deferAttempt: true, tx },
  );
  // Rendered before the trial row existed, so the dedupe key is set here.
  const emails = await stagePreparedEmails(tx, {
    ...args.preparedEmails,
    entityRef: `trial:${args.trialId}`,
  });
  return { consulteeBell, consultantBell, emails };
}
