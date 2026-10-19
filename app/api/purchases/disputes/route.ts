import { NextResponse, type NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { RaiseDisputeSchema, raiseDispute } from "@/lib/support/disputes/raise";
import { DisputeActionError } from "@/lib/support/disputes/actions";

/**
 * The buyer's dispute surface.
 *
 * `POST` raises a dispute on a payment. `GET` lists the caller's own
 * disputes — the buyer side AND the respondent side, because the person
 * answering a claim is also a person with a dispute in their list.
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const disputes = await prisma.purchaseDispute.findMany({
    where: {
      OR: [{ buyerUserId: userId }, { respondentUserId: userId }],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      referenceNumber: true,
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
      payment: {
        select: {
          id: true,
          amount: true,
          currency: true,
          appointmentId: true,
        },
      },
      supportCase: {
        select: {
          referenceNumber: true,
          status: true,
          title: true,
        },
      },
    },
  });

  return NextResponse.json(
    {
      data: disputes.map((d) => ({
        id: d.id,
        referenceNumber: d.referenceNumber,
        status: d.status,
        reason: d.reason,
        round: d.round,
        // Whose move it is. A respondent sees "you need to answer"; a buyer
        // sees the platform's or their own next step.
        role: d.buyerUserId === userId ? "BUYER" : "RESPONDENT",
        respondentType: d.respondentType,
        respondentUserId: d.respondentUserId,
        respondentOrganizationId: d.respondentOrganizationId,
        amountPaise: d.amountAtStakePaise,
        respondentDueAt: d.respondentDueAt,
        respondentRespondedAt: d.respondentRespondedAt,
        buyerDecision: d.buyerDecision,
        escalatedAt: d.escalatedAt,
        resolvedAt: d.resolvedAt,
        createdAt: d.createdAt,
        payment: d.payment,
        case: d.supportCase,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;

  const limited = await applyRateLimit(
    spamLimiter,
    `dispute-raise:${auth.session.user.id}`,
  );
  if (limited) return limited;

  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;

  const parsed = RaiseDisputeSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return supportError({
      status: 400,
      code: "VALIDATION_FAILED",
      detail: parsed.error.flatten(),
    });
  }

  try {
    const result = await raiseDispute(auth.session.user.id, parsed.data);
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof DisputeActionError) {
      return supportError({
        status: error.status,
        code: error.status === 409 ? "CONFLICT" : "VALIDATION_FAILED",
        message: error.message,
        detail: error.details,
      });
    }
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause: error,
      context: { route: "purchases.disputes", action: "raise" },
    });
  }
}
