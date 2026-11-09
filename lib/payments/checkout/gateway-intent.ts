// Records a gateway order an in-transaction abort left behind, so a late
// capture on it has a row to be refunded against.

import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import {
  type Currency,
  type GstRegime,
  PaymentGateway,
  PaymentStatus,
} from "@prisma/client";

/**
 * Manages payment intent creation and cleanup with proper error handling
 */
/**
 * #1695 — record a gateway order that was minted and then abandoned by an
 * in-transaction abort, so a late capture on it has a row to be refunded
 * against. EXPIRED with `expiresAt` now: no sweep re-drives it (they cohort on
 * PENDING) and no checkout resumes it. A failure here must not mask the abort
 * the buyer is about to hear about, so it only reports — and returns whether
 * the row landed, for a caller whose next answer depends on it.
 */
export async function tombstoneAbortedGatewayOrder(input: {
  paymentIntent: string;
  userId: string;
  amount: number;
  originalAmount: number;
  taxAmount: number;
  gstRegime: GstRegime;
  currency: Currency;
  reason: string;
}): Promise<boolean> {
  try {
    await prisma.payment.create({
      data: {
        amount: input.amount,
        originalAmount: input.originalAmount,
        taxAmount: input.taxAmount,
        gstRegime: input.gstRegime,
        currency: input.currency,
        paymentMethod: "CARD",
        paymentIntent: input.paymentIntent,
        paymentGateway: PaymentGateway.RAZORPAY,
        paymentStatus: PaymentStatus.EXPIRED,
        expiresAt: new Date(),
        userId: input.userId,
        description: `Checkout aborted after the gateway order was minted (${input.reason.slice(0, 160)}). A late capture on this order is auto-refunded.`,
        // The funding-leg trigger rejects a priced Payment with no legs at COMMIT.
        ...(input.amount > 0 && {
          legs: {
            create: {
              source: "CARD",
              amountPaise: input.amount,
              sourceRef: input.paymentIntent,
            },
          },
        }),
      },
    });
    return true;
  } catch (tombstoneError) {
    reportSentryError(tombstoneError, {
      subsystem: "payments",
      extra: { paymentIntent: input.paymentIntent },
    });
    return false;
  }
}
