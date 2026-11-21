/**
 * Whether the operator refund door may take a payment: the Ops panel offers
 * "Issue refund" on this answer and the issue door refuses on it, so the two
 * never disagree. The refund writer re-checks every rule in its own transaction.
 */

import type { PaymentStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  fundingRailForIntent,
  isPriceFreePayment,
} from "@/lib/payments/funding-rail";
import { assertRefundReplayMatches } from "@/lib/payments/operations/refund";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
  RETURNED_REFUND_STATUSES,
} from "@/lib/payments/refundable-balance";
import { OpsRefusal } from "./ops-refusal-error";

/** The payment fields the answer reads; the Ops panel's payment read selects them too. */
export const REFUND_DOOR_SELECT = {
  paymentStatus: true,
  paymentIntent: true,
  amount: true,
  originalAmount: true,
  ...REFUNDABLE_BALANCE_SELECT,
  creditUsages: { select: { amount: true } },
} as const;

type AmountWithStatus = { amountPaise: number; status: string };

export interface RefundDoorPayment {
  paymentStatus: PaymentStatus;
  paymentIntent: string;
  amount: number | bigint;
  originalAmount: number | bigint;
  refunds: AmountWithStatus[];
  disputes: AmountWithStatus[];
  creditUsages: { amount: number | bigint }[];
}

export type RefundDoorRefusal = {
  code:
    | "PAYMENT_NOT_SUCCEEDED"
    | "PRICE_FREE_PAYMENT"
    | "ALREADY_FULLY_REFUNDED"
    | "REFUND_BLOCKED_BY_DISPUTE";
  message: string;
};

const INACTIVE_DISPUTES: ReadonlySet<string> = new Set(
  DISPUTE_INACTIVE_FOR_GATING,
);

/** Null when the door may refund the payment; otherwise why it may not. */
export function refundDoorRefusal(
  p: RefundDoorPayment,
): RefundDoorRefusal | null {
  if (p.paymentStatus !== "SUCCEEDED") {
    return {
      code: "PAYMENT_NOT_SUCCEEDED",
      message: "Only a completed payment can be refunded.",
    };
  }
  const rail = fundingRailForIntent(p.paymentIntent);
  if (rail === "CREDITS") {
    // A price-free seat paid nothing and spent no credit, so a refund here would only revoke it.
    if (
      isPriceFreePayment({
        paymentIntent: p.paymentIntent,
        amountPaise: Number(p.amount),
        listPricePaise: Number(p.originalAmount),
      })
    ) {
      return {
        code: "PRICE_FREE_PAYMENT",
        message:
          "This seat was free, so nothing was paid and there is nothing to refund.",
      };
    }
    // The credits rail restores once: any returned refund row is that restoration.
    const restored = p.refunds.some((r) =>
      RETURNED_REFUND_STATUSES.has(r.status),
    );
    const stillUsed = p.creditUsages.reduce((s, u) => s + Number(u.amount), 0);
    return restored || stillUsed <= 0
      ? {
          code: "ALREADY_FULLY_REFUNDED",
          message: "The credits behind this booking were already returned.",
        }
      : null;
  }
  if (refundableBalancePaise(Number(p.amount), p) <= 0) {
    return {
      code: "ALREADY_FULLY_REFUNDED",
      message: "Nothing is left to refund on this payment.",
    };
  }
  if (
    rail === "GATEWAY" &&
    p.disputes.some((d) => !INACTIVE_DISPUTES.has(d.status))
  ) {
    return {
      code: "REFUND_BLOCKED_BY_DISPUTE",
      message:
        "This payment has an open dispute. Wait for its outcome before refunding.",
    };
  }
  return null;
}

/**
 * Refuses a refund the door may not take. A key whose refund already went
 * through answers with that refund, so the writer replays a retried click; a
 * key spent on another payment or amount throws IDEMPOTENCY_KEY_REUSED.
 */
export async function assertRefundDoorOpen(
  paymentId: string,
  dedupeKey: string,
  amountPaise?: number,
): Promise<{ amountPaise: number } | null> {
  const spent = await prisma.refund.findUnique({
    where: { dedupeKey },
    select: { paymentId: true, amountPaise: true, status: true },
  });
  if (spent && RETURNED_REFUND_STATUSES.has(spent.status)) {
    assertRefundReplayMatches(spent, { paymentId, amountPaise });
    return { amountPaise: Number(spent.amountPaise) };
  }
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId, deletedAt: null },
    select: REFUND_DOOR_SELECT,
  });
  if (!payment) {
    throw new OpsRefusal("PAYMENT_NOT_FOUND", "Payment not found.", 404);
  }
  const refusal = refundDoorRefusal(payment);
  if (refusal) throw new OpsRefusal(refusal.code, refusal.message);
  return null;
}
