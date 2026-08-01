/**
 * Refund ONE booking payment, whatever rail funded it (#1003, #1020).
 *
 * `refundPayment` calls the gateway unconditionally, and an org-funded booking
 * carries a synthetic `org_wallet_` / `org_license_` / `org_invoice_`
 * paymentIntent that no gateway can resolve. So every org-funded 1:1
 * cancellation died on UNKNOWN_GATEWAY in Phase 2 — before the cascade ran —
 * and the caller swallowed it as "refunded 0". Nothing was reversed: the org
 * wallet was never credited back, the invoice accrual never netted down, the
 * program engagement never returned to the cap, the consultant's earnings
 * stayed payable and no ledger entry was written.
 *
 * `refundWholeEventPayments` already splits the two rails for class/webinar
 * seats. 1:1 bookings had no equivalent; this is that split, and it is the
 * front door every 1:1 cancellation/rejection refund should use.
 *
 *   - GATEWAY / MOCK — real card money, must credit the card, so it keeps
 *     going through `refundPayment` (which owns the two-phase gateway
 *     discipline and its own overage credit-back).
 *   - INTERNAL org-funded — no card was ever charged; the money lives in the
 *     wallet / invoice accrual / license ledger, so it reverses purely
 *     in-ledger through the reversal engine's BOOKING source.
 */

import { Prisma, PaymentStatus, RefundStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { applyReversal } from "./reversal-engine";
import { RefundValidationError, refundPayment } from "./refund";

export type BookingRefundResult = {
  refundId: string;
  amountRefundedPaise: number;
  /** Which rail actually returned the money. */
  rail: "GATEWAY" | "INTERNAL";
};

/** Org-funded bookings carry a synthetic paymentIntent no gateway can refund. */
export function isInternalFundedIntent(paymentIntent: string): boolean {
  return paymentIntent.startsWith("org_");
}

export async function refundBookingPayment(input: {
  paymentId: string;
  /** Defaults to the full remaining refundable balance. */
  amountPaise?: number;
  reason: string;
  initiatedByUserId?: string | null;
}): Promise<BookingRefundResult> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: { paymentIntent: true },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }

  if (!isInternalFundedIntent(payment.paymentIntent)) {
    const r = await refundPayment(input);
    return {
      refundId: r.refundId,
      amountRefundedPaise: r.amountRefundedPaise,
      rail: "GATEWAY",
    };
  }

  return refundInternalFundedPayment(input);
}

/**
 * In-ledger reversal of an org-funded booking payment.
 *
 * Mirrors the shape `reverseClassMulti` uses per child — mint the Refund row,
 * run the proven cascade against it, flip it SUCCEEDED — inside one
 * Serializable transaction, which is what `applyRefundCascade` requires for
 * race-safety. There is no gateway leg to wait on, so unlike `refundPayment`
 * this settles in a single phase.
 */
async function refundInternalFundedPayment(input: {
  paymentId: string;
  amountPaise?: number;
  reason: string;
  initiatedByUserId?: string | null;
}): Promise<BookingRefundResult> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      displayCurrencyAtCheckout: true,
      exchangeRateAtCheckout: true,
    },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED (status=${payment.paymentStatus}); cannot refund`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Re-derive the balance inside the Serializable tx so two concurrent
        // reversals cannot oversubscribe. A synthetic intent can never carry a
        // gateway dispute, so — unlike refundPayment — there is no chargeback
        // term to net out here.
        const priorRefunds = await tx.refund.findMany({
          where: {
            paymentId: payment.id,
            status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
          },
          select: { amountPaise: true },
        });
        const refundable =
          payment.amount - priorRefunds.reduce((a, r) => a + r.amountPaise, 0);
        if (refundable <= 0) {
          throw new RefundValidationError(
            `Payment ${payment.id} has no refundable balance`,
            "ALREADY_FULLY_REFUNDED",
          );
        }

        const requested = input.amountPaise ?? refundable;
        if (requested <= 0) {
          throw new RefundValidationError(
            `Refund amount must be positive; got ${requested}`,
            "INVALID_AMOUNT",
          );
        }
        if (requested > refundable) {
          throw new RefundValidationError(
            `Refund amount ${requested} exceeds refundable ${refundable} on payment ${payment.id}`,
            "AMOUNT_EXCEEDS_REFUNDABLE",
          );
        }

        const refundRow = await tx.refund.create({
          data: {
            paymentId: payment.id,
            amountPaise: requested,
            currency: payment.currency,
            reason: input.reason,
            status: RefundStatus.PENDING,
            // No gateway ever mints an id for these, so the row owns its own.
            refundId: `internal_${globalThis.crypto.randomUUID()}`,
            paymentGateway: payment.paymentGateway,
            exchangeRateAtRefund: payment.exchangeRateAtCheckout,
            displayCurrency: payment.displayCurrencyAtCheckout,
            metadata: {
              initiatedByUserId: input.initiatedByUserId ?? null,
              source: "internal-funded",
            } as Prisma.InputJsonValue,
          },
        });

        await applyReversal(tx, {
          source: { kind: "BOOKING", paymentId: payment.id },
          amountPaise: requested,
          reason: input.reason,
          refundId: refundRow.id,
          initiatedByUserId: input.initiatedByUserId ?? null,
        });

        await tx.refund.update({
          where: { id: refundRow.id },
          data: { status: RefundStatus.SUCCEEDED },
        });

        // Same ordering rule as refundPayment Phase 3b: credit restoration
        // reads the cumulative SUCCEEDED refund total, so it must run after
        // the flip above or it under-restores.
        await reverseCreditsForPayment(
          payment.id,
          tx,
          requested,
          payment.amount,
        );

        return {
          refundId: refundRow.id,
          amountRefundedPaise: requested,
          rail: "INTERNAL" as const,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
