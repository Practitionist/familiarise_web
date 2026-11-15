import prisma from "@/lib/prisma";
import { notifyTrialCompleted } from "@/lib/novu/service";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { stageTrialLifecycleEmail } from "@/lib/email/senders/booking";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import { getAppUrl } from "@/lib/url";

export interface TrialCompletedParties {
  trialId: string;
  consultantUserId: string | null | undefined;
  consulteeUserId: string | null | undefined;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  subscriptionPlanId: string;
  startsAt?: Date | null;
  /** Where the expert's bell opens. */
  dashboardUrl: string;
}

/** The plan the trial was for, where the learner continues with the expert. */
export function trialContinueUrl(subscriptionPlanId: string): string {
  return `${getAppUrl()}/checkout/plans/subscription/${encodeURIComponent(subscriptionPlanId)}`;
}

/**
 * A completed trial: the learner gets one bell and one email, "Continue with
 * {expert}", that open the plan; the expert gets a bell only. Stages without
 * attempting, so the caller flushes after its commit. Never throws.
 */
export async function stageTrialCompletedNotices(
  args: TrialCompletedParties,
): Promise<{
  bells: Array<StagedTrigger | undefined>;
  emails: StagedRecipientEmail[];
}> {
  const continueUrl = trialContinueUrl(args.subscriptionPlanId);
  const dateTime = args.startsAt?.toISOString();
  const base = {
    consultantName: args.consultantName,
    consulteeName: args.consulteeName,
    planTitle: args.planTitle,
    status: "COMPLETED",
    ...(dateTime ? { dateTime } : {}),
  };
  const fail = (what: string) => (error: unknown) => {
    console.error(`[trial-completed] Failed to stage the ${what}:`, error);
    return [];
  };
  const learner = args.consulteeUserId;
  const expert = args.consultantUserId;
  const [learnerBells, expertBells, emails] = await Promise.all([
    learner
      ? notifyTrialCompleted(
          [learner],
          {
            ...base,
            continueWith: args.consultantName,
            dashboardUrl: continueUrl,
          },
          { deferAttempt: true },
        ).catch(fail("learner bell"))
      : [],
    expert && expert !== learner
      ? notifyTrialCompleted(
          [expert],
          { ...base, dashboardUrl: args.dashboardUrl },
          { deferAttempt: true },
        ).catch(fail("expert bell"))
      : [],
    learner
      ? stageTrialLifecycleEmail(prisma, {
          trialId: args.trialId,
          userIds: [learner],
          kind: "TRIAL_COMPLETED",
          planTitle: args.planTitle,
          consultantName: args.consultantName,
          consulteeName: args.consulteeName,
          consulteeUserId: learner,
          ...(expert ? { consultantUserId: expert } : {}),
          startsAt: args.startsAt ?? null,
          dashboardUrl: continueUrl,
        }).catch(fail("learner email"))
      : [],
  ]);
  return {
    bells: [...learnerBells, ...expertBells].map((r) => r.staged),
    emails,
  };
}
