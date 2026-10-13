import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth-helpers";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { rateFlowOutcome } from "@/lib/support/deflection";

const OutcomeIdParamsSchema = z.object({
  id: z.string().min(1).max(64),
});

const RatingBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const parsedParams = await parseRouteParams(OutcomeIdParamsSchema, params, {
    route: "support.flow-outcomes.rating",
  });
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const userId = auth.session.user.id;

    const rl = await applyRateLimit(
      spamLimiter,
      `flow-outcome-rating:${userId}`,
    );
    if (rl) return rl;

    const parsedBody = RatingBodySchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsedBody.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsedBody.error.flatten(),
        context: {
          route: "support.flow-outcomes.rating",
          action: "rate",
          outcomeId: id,
        },
      });
    }

    const outcome = await rateFlowOutcome(id, userId, parsedBody.data.rating);
    if (!outcome.updated) {
      return NextResponse.json(
        { error: "Flow outcome already rated or not found" },
        { status: 409 },
      );
    }

    return NextResponse.json({ data: { updated: true } });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: {
        route: "support.flow-outcomes.rating",
        action: "rate",
        outcomeId: id,
      },
    });
  }
}
