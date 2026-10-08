/**
 * What `/checkout/pending/[paymentId]` shows: one unpaid charge, as its payer
 * reads it. The viewer's id is in the WHERE, so another user's payment reads
 * as "not found" and never as "not yours".
 */

import type { Currency, PaymentStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";

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
      expiresAt: true,
      appointmentId: true,
      discountCode: { select: { code: true } },
      creditUsages: { select: { amount: true } },
      legs: {
        where: { source: "REFERRAL_CREDIT" },
        select: { amountPaise: true },
        take: 1,
      },
      user: { select: { consulteeProfile: { select: { id: true } } } },
      appointment: {
        select: {
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
  const creditsPaise =
    payment.creditUsages.length > 0
      ? payment.creditUsages.reduce(
          (sum, usage) => sum + Number(usage.amount),
          0,
        )
      : Number(payment.legs?.[0]?.amountPaise ?? 0);
  // amount = base − discount + GST − credits, so the discount is what is left.
  const discountPaise = Math.max(
    0,
    payment.originalAmount + payment.taxAmount - creditsPaise - payment.amount,
  );

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
    expiresAt: payment.expiresAt,
    appointmentId: payment.appointmentId,
    consulteeProfileId: payment.user.consulteeProfile?.id ?? null,
  });
}
