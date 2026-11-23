import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { sessionRole } from "@/lib/auth/session-role";
import { canCorrespondOnCase } from "@/lib/support/case-access";
import { CaseActionError, quoteCaseRefund } from "@/lib/support/case-actions";

const Params = z.object({
  caseId: z.string().min(1).max(64),
  recommendationId: z.string().min(1).max(128),
});

/** The side-effect-free quote a reviewer confirms; approval re-checks the same figures. */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ caseId: string; recommendationId: string }> },
) {
  const auth = await requireBackofficeSurface("supportRefunds.executeBounded");
  if (auth.error) return auth.error;
  const params = Params.safeParse(await context.params);
  if (!params.success)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { caseId, recommendationId } = params.data;
  const viewer = {
    userId: auth.session.user.id,
    role: sessionRole(auth.session.user.role),
  };
  const quote = await prisma
    .$transaction(async (tx) => {
      const supportCase = await tx.supportCase.findFirst({
        where: { id: caseId, deletedAt: null },
      });
      if (!supportCase || !(await canCorrespondOnCase(supportCase, viewer, tx)))
        return null;
      const recommendation = await tx.supportFinancialRecommendation.findFirst({
        where: { id: recommendationId, caseId },
      });
      if (!recommendation) return null;
      return {
        amountPaise: Number(recommendation.amountPaise),
        ...(await quoteCaseRefund(tx, caseId, recommendation)),
      };
    })
    .catch((error: unknown) => {
      if (error instanceof CaseActionError) return null;
      throw error;
    });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    data: {
      refundablePaise: quote.refundablePaise,
      amountPaise: quote.amountPaise,
      rail: quote.rail,
      blockedReason: quote.blocked?.reason ?? null,
      note: quote.note,
      committedPaise: quote.committedPaise,
    },
  });
}
