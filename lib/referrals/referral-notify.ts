/** Referral bells and emails, staged in the transaction that moves the credit. */

import type { PrismaLike, Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import {
  prepareReferralBonusEmail,
  stageReferralBonusEmail,
  type ReferralBonusEmailArgs,
} from "@/lib/email/senders/money";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import {
  notifyRefereeWelcomeBonus,
  notifyReferralBonusEarned,
  notifyReferralCreditsApplied,
} from "@/lib/novu/service";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";
import { getAppUrl } from "@/lib/url";
import { sumPaise } from "@/lib/payments/utils/money";
import { getUserCredits } from "./service";

/** A vested referrer reward, or the referee's welcome discount cap. */
export async function stageReferralReward(
  tx: Tx,
  args: {
    kind: "BONUS_EARNED" | "WELCOME_BONUS";
    userId: string;
    referralId: string;
    counterpartyName: string;
    amountPaise: number;
  },
): Promise<StagedNotificationBundle> {
  if (args.amountPaise <= 0) return {};
  const dashboardUrl = `${getAppUrl()}${goHref("client", "payments")}`;
  const common = {
    bonusAmountPaise: args.amountPaise,
    currency: "INR",
    dashboardUrl,
  };
  const opts = {
    tx,
    dedupeKey: `referral:${args.referralId}:${args.kind}`,
    entityRef: `referral:${args.referralId}`,
  };
  const bell =
    args.kind === "BONUS_EARNED"
      ? await notifyReferralBonusEarned(
          args.userId,
          { ...common, refereeName: args.counterpartyName },
          opts,
        )
      : await notifyRefereeWelcomeBonus(
          args.userId,
          { ...common, referrerName: args.counterpartyName },
          opts,
        );
  const list = await stageReferralBonusEmail(tx, {
    ...args,
    currency: "INR",
    dashboardUrl,
  });
  return {
    bells: [bell.staged],
    emails: [{ list, emailType: `REFERRAL_${args.kind}` }],
  };
}

export interface CreditsApplied {
  userId: string;
  paymentId: string;
  creditsUsedPaise: number;
  remainingPaise: number;
  appointmentType: string;
}

function creditsAppliedEmail(args: CreditsApplied): ReferralBonusEmailArgs {
  return {
    kind: "CREDITS_APPLIED",
    userId: args.userId,
    paymentId: args.paymentId,
    amountPaise: args.creditsUsedPaise,
    remainingPaise: args.remainingPaise,
    currency: "INR",
    appointmentType: args.appointmentType,
    dashboardUrl: `${getAppUrl()}/dashboard`,
  };
}

/** What checkout redeemed on `paymentId`; null when it used no credits. */
export async function readCreditsApplied(
  db: PrismaLike,
  input: { userId: string; paymentId: string; appointmentType: string },
): Promise<CreditsApplied | null> {
  const usages = await db.referralCreditUsage.findMany({
    where: { paymentId: input.paymentId },
    select: { originalAmount: true },
  });
  const creditsUsedPaise = usages.reduce(
    (sum, u) => sum + sumPaise(u.originalAmount),
    0,
  );
  if (creditsUsedPaise <= 0) return null;
  const { totalAvailable } = await getUserCredits(input.userId, db);
  return { ...input, creditsUsedPaise, remainingPaise: totalAvailable };
}

/** Renders the credits-applied email before the capture transaction opens. */
export function prepareCreditsAppliedEmail(
  args: CreditsApplied,
): Promise<PreparedSpecEmails> {
  return prepareReferralBonusEmail(creditsAppliedEmail(args));
}

/** The payer's credits-applied bell and email, keyed by the payment that redeemed them. */
export async function stageCreditsApplied(
  tx: Tx,
  args: CreditsApplied,
  pre?: PreparedSpecEmails | null,
): Promise<StagedNotificationBundle> {
  if (args.creditsUsedPaise <= 0) return {};
  const bell = await notifyReferralCreditsApplied(
    args.userId,
    {
      creditsUsed: args.creditsUsedPaise,
      remainingCredits: args.remainingPaise,
      currency: "INR",
      appointmentType: args.appointmentType,
      dashboardUrl: `${getAppUrl()}/dashboard`,
    },
    {
      tx,
      dedupeKey: `payment:${args.paymentId}:referral-credits-applied`,
      entityRef: `payment:${args.paymentId}`,
    },
  );
  const list = await stageReferralBonusEmail(
    tx,
    creditsAppliedEmail(args),
    pre,
  );
  return {
    bells: [bell.staged],
    emails: [{ list, emailType: "REFERRAL_CREDITS_APPLIED" }],
  };
}
