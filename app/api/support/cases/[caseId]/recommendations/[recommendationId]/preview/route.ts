import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { fundingRailForIntent } from "@/lib/payments/funding-rail";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { parseRouteParams } from "@/lib/api/support-http";
import { CaseRecommendationParams } from "@/schemas/support";
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ caseId: string; recommendationId: string }> },
) {
  const ids = await parseRouteParams(CaseRecommendationParams, context.params, {
    route: "support.case.recommendation.preview",
  });
  if (!ids.ok) return ids.response;
  const auth = await requireBackofficeSurface("refunds.manage");
  if (auth.error) return auth.error;
  const { caseId, recommendationId } = ids.data;
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
