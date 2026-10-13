/** Best-effort post-commit referral bells and emails; never throws. */

import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { stageReferralBonusEmail } from "@/lib/email/senders/money";
import { notifyReferralCreditsApplied } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { getUserCredits } from "./service";

function dashboardUrl(): string {
  return `${getAppUrl()}/dashboard`;
}

/**
 * After `applyCreditsToPayment()` commits at checkout, stage and flush the bell
 * and email twin with the balance the transaction saw. Never throws.
 */
export async function notifyCreditsAppliedBestEffort(args: {
  userId: string;
  creditsUsedPaise: number;
  /** Balance read inside the checkout transaction; re-read only when absent. */
  remainingPaise?: number | null;
  appointmentType: string;
  referralId?: string;
}): Promise<void> {
  try {
    if (args.creditsUsedPaise <= 0) return;
    const remaining =
      args.remainingPaise ?? (await getUserCredits(args.userId)).totalAvailable;
    const url = dashboardUrl();
    const [bell, emails] = await Promise.all([
      notifyReferralCreditsApplied(
        args.userId,
        {
          creditsUsed: args.creditsUsedPaise,
          remainingCredits: remaining,
          currency: "INR",
          appointmentType: args.appointmentType,
          dashboardUrl: url,
        },
        { deferAttempt: true },
      ).catch((err) => {
        console.error("[credits-applied-bell] failed:", err);
        return null;
      }),
      stageReferralBonusEmail(prisma, {
        userId: args.userId,
        referralId: args.referralId ?? args.userId,
        kind: "CREDITS_APPLIED",
        amountPaise: args.creditsUsedPaise,
        remainingPaise: remaining,
        currency: "INR",
        appointmentType: args.appointmentType,
        dashboardUrl: url,
      }).catch(() => []),
    ]);
    await flushNotificationsAfter(
      {
        bells: [bell?.staged],
        emails: [
          {
            list: emails,
            emailType: "REFERRAL_CREDITS_APPLIED",
          },
        ],
      },
      "referral.credits_applied",
    );
  } catch (err) {
    console.error("[credits-applied-bell] failed:", err);
  }
}
