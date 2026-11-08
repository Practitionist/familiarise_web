import {
  PaymentStatus,
  type Currency,
  type GstRegime,
  type PaymentGateway,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";

/** The attempt a re-mint replaces: its gateway order and the figures that order was minted for. */
export type PriorIntent = {
  id: string;
  userId: string;
  paymentIntent: string;
  gatewayPaymentId: string | null;
  amount: number;
  originalAmount: number;
  taxAmount: number;
  currency: Currency;
  paymentGateway: PaymentGateway;
  /** Copied so a late capture on the tombstone keeps the regime it was priced under. */
  gstRegime: GstRegime | null;
};

/**
 * Call after the re-mint CAS moved `prior.id` off its old intent: an EXPIRED, appointment-less row keeps
 * the old order with its legs and credit usages, so a late capture on it lands and is auto-refunded.
 */
export async function tombstonePriorIntent(
  tx: Tx,
  prior: PriorIntent,
  reason: string,
): Promise<void> {
  const tombstone = await tx.payment.create({
    data: {
      amount: prior.amount,
      originalAmount: prior.originalAmount,
      taxAmount: prior.taxAmount,
      gstRegime: prior.gstRegime,
      currency: prior.currency,
      paymentMethod: "CARD",
      paymentIntent: prior.paymentIntent,
      gatewayPaymentId: prior.gatewayPaymentId,
      paymentGateway: prior.paymentGateway,
      paymentStatus: PaymentStatus.EXPIRED,
      expiresAt: new Date(),
      userId: prior.userId,
      appointmentId: null,
      description: `Order replaced by a re-mint (${reason.slice(0, 160)}). A late capture on this order is auto-refunded.`,
    },
    select: { id: true },
  });
  const moved = await tx.paymentLeg.updateMany({
    where: { paymentId: prior.id },
    data: { paymentId: tombstone.id },
  });
  if (moved.count === 0 && prior.amount > 0) {
    await tx.paymentLeg.create({
      data: {
        paymentId: tombstone.id,
        source: "CARD",
        amountPaise: prior.amount,
        sourceRef: prior.paymentIntent,
      },
    });
  }
  await tx.referralCreditUsage.updateMany({
    where: { paymentId: prior.id },
    data: { paymentId: tombstone.id },
  });
}
