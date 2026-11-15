/**
 * The "trial scheduled" bell to each side and the email to both. Everything
 * they read (recipients, preferences, zones, suppressions, the render) runs
 * before the transaction that confirms the time; inside it they are two
 * inserts, so a rollback takes them too. The caller flushes the staged rows
 * after the commit (`flushNotificationsAfter`).
 */
import { TrialStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import { getAppUrl } from "@/lib/url";
import { prepareTrialScheduledEmail } from "@/lib/email/senders/booking";
import {
  screenPreparedEmails,
  stageScreenedEmails,
  type ScreenedRecipientEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import {
  prepareTrialScheduledBells,
  stagePreparedBells,
  type PreparedBell,
  type StagedTrigger,
} from "@/lib/novu";

export interface PreparedScheduleNotices {
  bells: PreparedBell[];
  emails: ScreenedRecipientEmails;
}

export interface StagedScheduleNotices {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

/** Reads and renders the notices before the transaction; writes nothing. */
export async function prepareTrialScheduledNotices(args: {
  consulteeUserId: string;
  consultantUserId: string;
  consulteeName: string;
  consultantName: string;
  planTitle: string;
  startsAt: Date;
}): Promise<PreparedScheduleNotices> {
  const payload = {
    consultantName: args.consultantName,
    consulteeName: args.consulteeName,
    planTitle: args.planTitle,
    dateTime: args.startsAt.toISOString(),
    status: TrialStatus.SCHEDULED,
  };
  const bells = await prepareTrialScheduledBells([
    {
      subscriberId: args.consulteeUserId,
      input: { ...payload, dashboardUrl: goHref("client", "appointments") },
    },
    {
      subscriberId: args.consultantUserId,
      input: { ...payload, dashboardUrl: goHref("expert", "appointments") },
    },
  ]);
  const prepared = await prepareTrialScheduledEmail({
    // The dedupe key is set when the rows are staged, once the trial exists.
    trialId: "pending",
    consulteeUserId: args.consulteeUserId,
    consultantUserId: args.consultantUserId,
    consulteeName: args.consulteeName,
    consultantName: args.consultantName,
    planTitle: args.planTitle,
    startsAt: args.startsAt,
    awaitingPayment: false,
    dashboardUrl: `${getAppUrl()}${goHref("auto", "appointments")}`,
    paymentUrl: null,
  });
  return { bells, emails: await screenPreparedEmails(prepared) };
}

/** Stages the prepared notices on the booking's transaction: one insert per table. */
export async function stageTrialScheduledNotices(
  tx: Tx,
  trialId: string,
  prepared: PreparedScheduleNotices,
): Promise<StagedScheduleNotices> {
  const bells = await stagePreparedBells(tx, prepared.bells);
  const emails = await stageScreenedEmails(
    tx,
    prepared.emails,
    `trial:${trialId}`,
  );
  return { bells, emails };
}
