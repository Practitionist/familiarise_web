/**
 * A subscription paid wholly in referral credit that ended after some
 * sessions were delivered: the credits rail restores whole or not at all, so
 * ops answers its undelivered share by hand, and its tranches wait unheld
 * until they do.
 */
import { PaymentStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { stampTranchesOnCancel } from "@/lib/booking/subscription-cycle";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { isFreeCreditIntent } from "@/lib/payments/funding-rail";
import { RefundValidationError } from "./refund";

/**
 * Referral credit the payment still holds consumed: zero when no credit backs
 * it (a 100% discount code) or all of it already came back.
 */
export async function creditStillUsedPaise(
  db: Pick<Tx, "referralCreditUsage">,
  paymentId: string,
): Promise<number> {
  const sum = await db.referralCreditUsage.aggregate({
    where: { paymentId },
    _sum: { amount: true },
  });
  return Number(sum._sum.amount ?? 0);
}

/** The ops answer that a credit plan's queued partial return owes nothing. */
export const PARTIAL_CREDIT_CLOSED_PREFIX = "partial-credit-closed:";

const ENDED_PLAN_STATUSES = new Set<string>(["CANCELLED", "COMPLETED"]);

/**
 * An operator decides a credit plan's queued partial return owes nothing: the
 * tranches it left unheld start their hold, and the queue row retires, in the
 * caller's commit. Only a plan that has ended (cancelled or run out).
 */
export async function closeCreditReturnWithoutCredit(
  tx: Tx,
  input: {
    paymentId: string;
    initiatedByUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<{ stamped: number }> {
  const payment = await tx.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: {
      paymentIntent: true,
      paymentStatus: true,
      appointment: {
        select: { subscription: { select: { id: true, status: true } } },
      },
    },
  });
  const plan = payment?.appointment?.subscription;
  if (!payment || !plan) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not a subscription`,
      "NOT_SESSION_CREDIT",
    );
  }
  if (!isFreeCreditIntent(payment.paymentIntent)) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not credit-funded`,
      "NOT_CREDIT_FUNDED",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }
  if (!ENDED_PLAN_STATUSES.has(plan.status)) {
    throw new RefundValidationError(
      "This plan is still running; its earnings are released as its sessions are delivered.",
      "PLAN_STILL_LIVE",
    );
  }
  const stamped = await stampTranchesOnCancel(tx, {
    paymentId: input.paymentId,
    now: input.now ?? new Date(),
  });
  await recordSystemEvent({
    db: tx,
    strict: true,
    category: "BOOKING",
    severity: "INFO",
    message: `Credit plan payment ${input.paymentId}: no credit owed; earnings released`,
    context: {
      paymentId: input.paymentId,
      subscriptionId: plan.id,
      initiatedByUserId: input.initiatedByUserId,
      reason: input.reason,
      stamped,
    },
    correlationId: `${PARTIAL_CREDIT_CLOSED_PREFIX}${input.paymentId}`,
  });
  return { stamped };
}
