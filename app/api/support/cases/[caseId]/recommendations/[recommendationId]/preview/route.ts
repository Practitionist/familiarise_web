import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { fundingRailForIntent } from "@/lib/payments/funding-rail";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ caseId: string; recommendationId: string }> },
) {
  const auth = await requireBackofficeSurface("refunds.manage");
  if (auth.error) return auth.error;
  const { caseId, recommendationId } = await context.params;
  const recommendation = await prisma.supportFinancialRecommendation.findFirst({
    where: { id: recommendationId, caseId },
    include: {
      payment: {
        select: {
          amount: true,
          paymentIntent: true,
          paymentStatus: true,
          ...REFUNDABLE_BALANCE_SELECT,
        },
      },
    },
  });
  if (!recommendation)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const payment = recommendation.payment;
  let blockedReason: string | null = null;
  if (payment.paymentStatus !== "SUCCEEDED") {
    blockedReason = "Payment is not captured";
  } else if (
    payment.disputes.some(
      (dispute) => !DISPUTE_INACTIVE_FOR_GATING.includes(dispute.status),
    )
  ) {
    blockedReason = "A gateway chargeback is active";
  }
  return NextResponse.json({
    data: {
      refundablePaise: refundableBalancePaise(payment.amount, payment),
      amountPaise: recommendation.amountPaise,
      rail: fundingRailForIntent(payment.paymentIntent),
      blockedReason,
    },
  });
}
