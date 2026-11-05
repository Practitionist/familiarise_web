import type { Tx } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import { stageReferralBonusEmail } from "@/lib/email/senders/money";
import { stageBells } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";

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
  const bell = await stageBells(tx, {
    workflowId:
      args.kind === "BONUS_EARNED"
        ? NOVU_WORKFLOWS.REFERRAL_BONUS_EARNED
        : NOVU_WORKFLOWS.REFEREE_WELCOME_BONUS,
    recipients: [args.userId],
    dedupeKey: `referral:${args.referralId}:${args.kind}`,
    entityRef: `referral:${args.referralId}`,
    payload:
      args.kind === "BONUS_EARNED"
        ? { ...common, refereeName: args.counterpartyName }
        : { ...common, referrerName: args.counterpartyName },
  });
  const list = await stageReferralBonusEmail(tx, {
    ...args,
    currency: "INR",
    dashboardUrl,
  });
  return {
    bells: bell,
    emails: [{ list, emailType: `REFERRAL_${args.kind}` }],
  };
}

/** Payment identity keeps equal-sized redemptions distinct; only confirmed rails stage this. */
export async function stageCreditsApplied(
  tx: Tx,
  args: {
    userId: string;
    paymentId: string;
    creditsUsedPaise: number;
    remainingPaise: number;
    appointmentType: string;
  },
): Promise<StagedNotificationBundle> {
  if (args.creditsUsedPaise <= 0) return {};
  const dashboardUrl = `${getAppUrl()}/dashboard`;
  const bell = await stageBells(tx, {
    workflowId: NOVU_WORKFLOWS.REFERRAL_CREDITS_APPLIED,
    recipients: [args.userId],
    payload: {
      creditsUsed: args.creditsUsedPaise,
      remainingCredits: args.remainingPaise,
      currency: "INR",
      appointmentType: args.appointmentType,
      dashboardUrl,
    },
    dedupeKey: `payment:${args.paymentId}:referral-credits-applied`,
    entityRef: `payment:${args.paymentId}`,
  });
  const list = await stageReferralBonusEmail(tx, {
    userId: args.userId,
    paymentId: args.paymentId,
    kind: "CREDITS_APPLIED",
    amountPaise: args.creditsUsedPaise,
    remainingPaise: args.remainingPaise,
    currency: "INR",
    appointmentType: args.appointmentType,
    dashboardUrl,
  });
  return {
    bells: bell,
    emails: [{ list, emailType: "REFERRAL_CREDITS_APPLIED" }],
  };
}
