/**
 * P3 referral Novu wiring — best-effort post-commit bells for the referral
 * lifecycle. No Resend templates here by design (follow-up).
 *
 * `processQualifyingAction()` returns void and clamps/skips grants (annual
 * cap, monthly budget, CONSULTANT referees), so the amounts the bells need
 * are read back from the committed rows: a REWARDED referral plus its
 * REFERRAL_BONUS / REFEREE_BONUS credit rows. Anything missing means nothing
 * qualified and the bells stay silent. Never throws.
 */

import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import {
  notifyReferralBonusEarned,
  notifyRefereeWelcomeBonus,
  notifyReferralCreditsApplied,
} from "@/lib/novu/service";
import { getUserCredits } from "./service";

function dashboardUrl(): string {
  return `${getAppUrl()}/dashboard`;
}

/**
 * After `processQualifyingAction(qualifyingUserId, …)` commits, fan out the
 * referrer + referee bells from the committed rows. No-op when the referral
 * is not REWARDED or the credit rows are absent.
 */
export async function notifyReferralQualificationBestEffort(
  qualifyingUserId: string,
): Promise<void> {
  try {
    const referral = await prisma.referral.findUnique({
      where: { referredUserId: qualifyingUserId },
      include: { referralCode: { select: { userId: true } } },
    });
    if (!referral || referral.status !== "REWARDED") return;

    const referrerUserId = referral.referralCode.userId;
    const [referrer, referee] = await Promise.all([
      prisma.user.findUnique({
        where: { id: referrerUserId },
        select: { name: true, email: true },
      }),
      prisma.user.findUnique({
        where: { id: referral.referredUserId },
        select: { name: true, email: true },
      }),
    ]);
    if (!referrer || !referee) return;

    const referrerName = referrer.name ?? referrer.email ?? "Someone";
    const refereeName = referee.name ?? referee.email ?? "Someone";

    const credits = await prisma.referralCredit.findMany({
      where: { referralId: referral.id },
      select: { amount: true, source: true },
    });
    const referrerGrant = credits
      .filter((c) => c.source === "REFERRAL_BONUS")
      .reduce((sum, c) => sum + Number(c.amount), 0);
    const refereeGrant = credits
      .filter((c) => c.source === "REFEREE_BONUS")
      .reduce((sum, c) => sum + Number(c.amount), 0);

    if (referrerGrant > 0) {
      await notifyReferralBonusEarned(referrerUserId, {
        referrerName,
        refereeName,
        bonusAmount: referrerGrant,
        currency: "INR",
        dashboardUrl: dashboardUrl(),
      }).catch((err) => console.error("[referral-bonus-bell] failed:", err));
    }
    if (refereeGrant > 0) {
      await notifyRefereeWelcomeBonus(referral.referredUserId, {
        refereeName,
        referrerName,
        bonusAmount: refereeGrant,
        currency: "INR",
        dashboardUrl: dashboardUrl(),
      }).catch((err) => console.error("[referee-bonus-bell] failed:", err));
    }
  } catch (err) {
    console.error("[referral-qualification-bell] failed:", err);
  }
}

/**
 * After `applyCreditsToPayment()` commits at checkout, bell the payer.
 * `remainingCredits` is read live so the copy matches the committed ledger.
 * No-op when nothing was applied. Never throws.
 */
export async function notifyCreditsAppliedBestEffort(args: {
  userId: string;
  creditsUsedPaise: number;
  appointmentType: string;
}): Promise<void> {
  try {
    if (args.creditsUsedPaise <= 0) return;
    const { totalAvailable } = await getUserCredits(args.userId);
    await notifyReferralCreditsApplied(args.userId, {
      creditsUsed: args.creditsUsedPaise,
      remainingCredits: totalAvailable,
      currency: "INR",
      appointmentType: args.appointmentType,
      dashboardUrl: dashboardUrl(),
    }).catch((err) => console.error("[credits-applied-bell] failed:", err));
  } catch (err) {
    console.error("[credits-applied-bell] failed:", err);
  }
}
