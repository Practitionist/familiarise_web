import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

/**
 * The platform's buyer-dispute queue.
 *
 * Scoped to the operator's own tree by the surface guard; every dispute is
 * visible, because the platform adjudicates all of them. The money columns
 * are paise in the database and numbers at the Prisma boundary.
 */
export async function GET() {
  const auth = await requireBackofficeSurface("disputes.read");
  if (auth.error) return auth.error;

  const disputes = await prisma.purchaseDispute.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      referenceNumber: true,
      supportCaseId: true,
      status: true,
      reason: true,
      round: true,
      respondentType: true,
      respondentUserId: true,
      respondentOrganizationId: true,
      buyerUserId: true,
      amountAtStakePaise: true,
      respondentDueAt: true,
      respondentRespondedAt: true,
      buyerDecision: true,
      escalatedAt: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    {
      data: disputes.map((d) => ({
        id: d.id,
        referenceNumber: d.referenceNumber,
        caseId: d.supportCaseId,
        status: d.status,
        reason: d.reason,
        round: d.round,
        respondentType: d.respondentType,
        respondentUserId: d.respondentUserId,
        respondentOrganizationId: d.respondentOrganizationId,
        amountPaise: Number(d.amountAtStakePaise),
        respondentDueAt: d.respondentDueAt,
        respondentRespondedAt: d.respondentRespondedAt,
        buyerDecision: d.buyerDecision,
        escalatedAt: d.escalatedAt,
        resolvedAt: d.resolvedAt,
        createdAt: d.createdAt,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
