import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-helpers";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { submitSupportCaseCsat } from "@/lib/support/case-service";

const CaseIdParamsSchema = z.object({
  caseId: z.string().min(1).max(64),
});

const CsatBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
});

interface RouteParams {
  params: Promise<{ caseId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(CaseIdParamsSchema, params, {
    route: "support.case.csat",
  });
  if (!id.ok) return id.response;
  const { caseId } = id.data;

  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const userId = auth.session.user.id;

    const rl = await applyRateLimit(spamLimiter, `support-case-csat:${userId}`);
    if (rl) return rl;

    const parsed = CsatBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "support.case.csat", action: "submit", caseId },
      });
    }

    const result = await submitSupportCaseCsat({
      caseId,
      userId,
      rating: parsed.data.rating,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      data: { csatRating: result.csatRating, csatAt: result.csatAt },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.case.csat", action: "submit", caseId },
    });
  }
}
