/** Best-effort post-commit referral bells; never throws. */

import { getAppUrl } from "@/lib/url";
import { notifyReferralCreditsApplied } from "@/lib/novu/service";
import { getUserCredits } from "./service";

function dashboardUrl(): string {
  return `${getAppUrl()}/dashboard`;
}

/**
 * After `applyCreditsToPayment()` commits at checkout, bell the payer with the
 * balance the transaction saw (a later checkout must not change the figure
 * before the bell reads it). No-op when nothing was applied. Never throws.
 */
export async function notifyCreditsAppliedBestEffort(args: {
  userId: string;
  creditsUsedPaise: number;
  /** Balance read inside the checkout transaction; re-read only when absent. */
  remainingPaise?: number | null;
  appointmentType: string;
}): Promise<void> {
  try {
    if (args.creditsUsedPaise <= 0) return;
    const remaining =
      args.remainingPaise ?? (await getUserCredits(args.userId)).totalAvailable;
    await notifyReferralCreditsApplied(args.userId, {
      creditsUsed: args.creditsUsedPaise,
      remainingCredits: remaining,
      currency: "INR",
      appointmentType: args.appointmentType,
      dashboardUrl: dashboardUrl(),
    }).catch((err) => console.error("[credits-applied-bell] failed:", err));
  } catch (err) {
    console.error("[credits-applied-bell] failed:", err);
  }
}
