/**
 * What `/checkout/pending/[paymentId]` shows: one unpaid charge, as its payer
 * reads it. The viewer's id is in the WHERE, so another user's payment reads
 * as "not found" and never as "not yours".
 */

import type { Currency, PaymentStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import {
  deriveCheckoutAmount,
  type CheckoutDiscountInput,
} from "@/lib/payments/pricing/derive-checkout-amount";
import { appointmentTypeToServiceType } from "@/lib/payments/tax/tax-engine";
import { getUserCredits } from "@/lib/referrals/service";

export interface PendingCheckout {
  paymentId: string;
  status: PaymentStatus;
  planTitle: string;
  currency: Currency;
  /** Plan price before discount, GST and credits. */
  basePaise: number;
  discountPaise: number;
  discountCode: string | null;
  taxPaise: number;
  creditsPaise: number;
  totalPaise: number;
  /** Re-derived total from live coupon/credit state; null when the held order used credits or a welcome discount, which the row does not fully describe. */
  currentTotalPaise: number | null;
  /** Why the held quote may no longer hold: exhausted/expired coupon or spent credits. */
  quoteStaleReason: "COUPON_EXHAUSTED" | "COUPON_INVALID" | "CREDITS_SHORT" | null;
  expiresAt: Date | null;
  /** The booking the abandon door keys on; null for a charge with no booking. */
  appointmentId: string | null;
  consulteeProfileId: string | null;
}

const planTitleSelect = { select: { title: true } } as const;

export async function readPendingCheckout(args: {
  paymentId: string;
  viewerUserId: string;
}): Promise<PendingCheckout | null> {
  const { paymentId, viewerUserId } = args;
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      userId: viewerUserId,
      parentPaymentId: null,
      deletedAt: null,
    },
    select: {
      id: true,
      paymentStatus: true,
      amount: true,
      originalAmount: true,
      taxAmount: true,
      currency: true,
      buyerCountry: true,
      welcomeDiscountPaise: true,
      expiresAt: true,
      appointmentId: true,
      discountCode: {
        select: {
          code: true,
          discountType: true,
          discountValue: true,
          maxDiscount: true,
          isActive: true,
          expiresAt: true,
          maxUses: true,
          currentUses: true,
        },
      },
      creditUsages: { select: { amount: true } },
      user: { select: { id: true, consulteeProfile: { select: { id: true } } } },
      appointment: {
        select: {
          appointmentType: true,
          consultation: { select: { consultationPlan: planTitleSelect } },
          subscription: { select: { subscriptionPlan: planTitleSelect } },
          webinar: { select: { webinarPlan: planTitleSelect } },
          class: { select: { classPlan: planTitleSelect } },
          trial: { select: { subscriptionPlan: planTitleSelect } },
        },
      },
    },
  });
  if (!payment) return null;

  const a = payment.appointment;
  const creditsPaise = payment.creditUsages.reduce(
    (sum, usage) => sum + Number(usage.amount),
    0,
  );
  // amount = base − discount + GST − credits, so the discount is what is left.
  const discountPaise = Math.max(
    0,
    payment.originalAmount + payment.taxAmount - creditsPaise - payment.amount,
  );

  // Revalidate the held quote against live coupon/credit state. A number is
  // reported only when the held order is exactly re-derivable (no credits or
  // welcome discount, whose caps the row does not fully describe).
  let currentTotalPaise: number | null = null;
  let quoteStaleReason: PendingCheckout["quoteStaleReason"] = null;
  const liveCode = payment.discountCode;
  let liveDiscount: CheckoutDiscountInput | null = null;
  if (liveCode) {
    const codeDead =
      !liveCode.isActive ||
      (liveCode.expiresAt !== null && new Date() > liveCode.expiresAt);
    const codeExhausted =
      liveCode.maxUses !== null && liveCode.currentUses >= liveCode.maxUses;
    if (codeDead) {
      quoteStaleReason = "COUPON_INVALID";
    } else if (codeExhausted) {
      quoteStaleReason = "COUPON_EXHAUSTED";
    } else {
      liveDiscount = {
        discountType: liveCode.discountType,
        discountValue: Number(liveCode.discountValue),
        maxDiscount:
          liveCode.maxDiscount !== null ? Number(liveCode.maxDiscount) : null,
      };
    }
  }
  if (creditsPaise > 0) {
    const liveBalance = (await getUserCredits(payment.user.id)).totalAvailable;
    if (liveBalance < creditsPaise) quoteStaleReason ??= "CREDITS_SHORT";
  }
  if (creditsPaise === 0 && payment.welcomeDiscountPaise == null) {
    const rederived = await deriveCheckoutAmount({
      basePaise: payment.originalAmount,
      buyerCountry: payment.buyerCountry ?? "IN",
      serviceType: payment.appointment
        ? appointmentTypeToServiceType(payment.appointment.appointmentType)
        : "CONSULTING",
      discount: liveDiscount,
      welcomeDiscount: null,
    });
    currentTotalPaise = rederived.amount;
  }

  return toPlain({
    paymentId: payment.id,
    status: payment.paymentStatus,
    planTitle:
      a?.consultation?.consultationPlan?.title ??
      a?.subscription?.subscriptionPlan?.title ??
      a?.webinar?.webinarPlan?.title ??
      a?.class?.classPlan?.title ??
      a?.trial?.subscriptionPlan?.title ??
      "Your booking",
    currency: payment.currency,
    basePaise: payment.originalAmount,
    discountPaise,
    discountCode: payment.discountCode?.code ?? null,
    taxPaise: payment.taxAmount,
    creditsPaise,
    totalPaise: payment.amount,
    currentTotalPaise,
    quoteStaleReason,
    expiresAt: payment.expiresAt,
    appointmentId: payment.appointmentId,
    consulteeProfileId: payment.user.consulteeProfile?.id ?? null,
  });
}
