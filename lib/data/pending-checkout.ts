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
  /** Why a re-quoted checkout differs from the held order; advisory while the Razorpay hold is active. */
  quoteStaleReason:
    | "COUPON_EXHAUSTED"
    | "COUPON_INVALID"
    | "CREDITS_SHORT"
    | "TAX_CHANGED"
    | null;
  expiresAt: Date | null;
  /** The booking the abandon door keys on; null for a charge with no booking. */
  appointmentId: string | null;
  consulteeProfileId: string | null;
}

const planTitleSelect = { select: { title: true } } as const;

interface QuoteFreshnessInput {
  paymentStatus: PaymentStatus;
  amount: number;
  originalAmount: number;
  buyerCountry: string | null;
  welcomeDiscountPaise: number | null;
  userId: string;
  appointmentType: Parameters<typeof appointmentTypeToServiceType>[0] | null;
  discountCode: {
    discountType: CheckoutDiscountInput["discountType"];
    discountValue: number | bigint;
    maxDiscount: number | bigint | null;
    isActive: boolean;
    expiresAt: Date | null;
    maxUses: number | null;
    currentUses: number;
  } | null;
  creditsPaise: number;
  validHeldCreditsPaise: number;
  now: Date;
}

/**
 * Revalidates the held quote against live coupon, held+available wallet credits,
 * and current GST/LUT rules.
 */
async function resolveQuoteFreshness(input: QuoteFreshnessInput): Promise<{
  currentTotalPaise: number | null;
  quoteStaleReason: PendingCheckout["quoteStaleReason"];
}> {
  let quoteStaleReason: PendingCheckout["quoteStaleReason"] = null;
  let liveDiscount: CheckoutDiscountInput | null = null;
  const { discountCode: liveCode } = input;

  if (liveCode) {
    const codeDead =
      !liveCode.isActive ||
      (liveCode.expiresAt !== null && input.now > liveCode.expiresAt);
    // Subtract this PENDING payment's own slot so single-use/final-slot coupons do not self-exhaust.
    const effectiveOtherUses =
      input.paymentStatus === "PENDING"
        ? liveCode.currentUses - 1
        : liveCode.currentUses;
    const codeExhausted =
      liveCode.maxUses !== null && effectiveOtherUses >= liveCode.maxUses;

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

  // Only query remaining wallet balance when non-expired VESTED credits held on this order fall short.
  if (
    input.creditsPaise > 0 &&
    input.validHeldCreditsPaise < input.creditsPaise
  ) {
    const liveBalance = (await getUserCredits(input.userId)).totalAvailable;
    if (liveBalance + input.validHeldCreditsPaise < input.creditsPaise) {
      quoteStaleReason ??= "CREDITS_SHORT";
    }
  }

  let currentTotalPaise: number | null = null;
  if (input.creditsPaise === 0 && input.welcomeDiscountPaise === null) {
    const rederived = await deriveCheckoutAmount({
      basePaise: input.originalAmount,
      buyerCountry: input.buyerCountry ?? "IN",
      serviceType: input.appointmentType
        ? appointmentTypeToServiceType(input.appointmentType)
        : "CONSULTING",
      discount: liveDiscount,
      welcomeDiscount: null,
    });
    currentTotalPaise = rederived.amount;
    if (currentTotalPaise !== input.amount) {
      quoteStaleReason ??= "TAX_CHANGED";
    }
  }

  return { currentTotalPaise, quoteStaleReason };
}

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
      creditUsages: {
        select: {
          amount: true,
          credit: { select: { state: true, expiresAt: true } },
        },
      },
      legs: {
        where: { source: "REFERRAL_CREDIT" },
        select: { amountPaise: true },
        take: 1,
      },
      user: {
        select: { id: true, consulteeProfile: { select: { id: true } } },
      },
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

  const now = new Date();
  const a = payment.appointment;
  const creditsPaise =
    payment.creditUsages.length > 0
      ? payment.creditUsages.reduce(
          (sum, usage) => sum + Number(usage.amount),
          0,
        )
      : Number(payment.legs?.[0]?.amountPaise ?? 0);
  const validHeldCreditsPaise = payment.creditUsages.reduce((sum, usage) => {
    const isSpendable =
      usage.credit.state === "VESTED" &&
      (usage.credit.expiresAt === null || usage.credit.expiresAt > now);
    return isSpendable ? sum + Number(usage.amount) : sum;
  }, 0);
  // amount = base − discount + GST − credits, so the discount is what is left.
  const discountPaise = Math.max(
    0,
    payment.originalAmount + payment.taxAmount - creditsPaise - payment.amount,
  );

  const { currentTotalPaise, quoteStaleReason } = await resolveQuoteFreshness({
    paymentStatus: payment.paymentStatus,
    amount: payment.amount,
    originalAmount: payment.originalAmount,
    buyerCountry: payment.buyerCountry,
    welcomeDiscountPaise: payment.welcomeDiscountPaise,
    userId: payment.user.id,
    appointmentType: a?.appointmentType ?? null,
    discountCode: payment.discountCode,
    creditsPaise,
    validHeldCreditsPaise,
    now,
  });

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
