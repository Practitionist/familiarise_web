import type { Tx } from "@/lib/prisma";
import { notifyTrialCancelled } from "@/lib/novu";
import type { StagedTrigger } from "@/lib/novu/outbox";
import {
  prepareTrialLifecycleEmail,
  stageTrialLifecycleEmail,
  type TrialLifecycleEmailArgs,
} from "@/lib/email/senders/booking";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import type { RequiredOverride } from "@/lib/notifications/required-notices";

export interface TrialCancelNotice {
  trialId: string;
  /** Everyone told: the trial's parties except the one who cancelled. */
  userIds: string[];
  required: RequiredOverride | undefined;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  dashboardUrl: string;
}

function emailArgs(n: TrialCancelNotice): TrialLifecycleEmailArgs {
  return {
    trialId: n.trialId,
    userIds: n.userIds,
    kind: "TRIAL_CANCELLED",
    requiredFor: n.required?.recipients,
    planTitle: n.planTitle,
    consultantName: n.consultantName,
    consulteeName: n.consulteeName,
    dashboardUrl: n.dashboardUrl,
  };
}

/** Renders the cancel email before the cancel's transaction opens; null when rendering failed. */
export function prepareTrialCancelNotice(
  n: TrialCancelNotice,
): Promise<PreparedSpecEmails | null> {
  return prepareTrialLifecycleEmail(emailArgs(n)).catch(() => null);
}

/**
 * Stages the cancel bell and email on the cancel's own transaction, so a
 * staging failure rolls the cancel back instead of losing the notice. The
 * caller attempts them after the commit.
 */
export async function stageTrialCancelNotice(
  tx: Tx,
  n: TrialCancelNotice,
  pre: PreparedSpecEmails | null,
): Promise<{
  bells: Array<StagedTrigger | undefined>;
  emails: StagedRecipientEmail[];
}> {
  if (n.userIds.length === 0) return { bells: [], emails: [] };
  const bells = await notifyTrialCancelled(
    n.userIds,
    {
      consultantName: n.consultantName,
      consulteeName: n.consulteeName,
      planTitle: n.planTitle,
      status: "CANCELLED",
      dashboardUrl: n.dashboardUrl,
    },
    { tx, deferAttempt: true, required: n.required },
  );
  const emails = await stageTrialLifecycleEmail(tx, emailArgs(n), pre);
  return { bells: (bells ?? []).map((b) => b?.staged), emails };
}
