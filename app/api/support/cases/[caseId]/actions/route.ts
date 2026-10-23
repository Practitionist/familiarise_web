import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth-helpers";
import { isFreshSession, requireFreshSession } from "@/lib/auth/step-up";
import {
  CaseActionError,
  CaseActionRequestSchema,
  performCaseAction,
  readCaseResolution,
  type CaseAction,
} from "@/lib/support/case-actions";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import { reviewSupportRefundDoor } from "@/lib/support/refund-door";
import {
  applySupportHoldDoor,
  releaseSupportHoldDoor,
  voidSupportRecommendationDoor,
} from "@/lib/support/case-doors";
import { sessionRole } from "@/lib/auth/session-role";

const Params = z.object({ caseId: z.string().min(1).max(64) });
interface Context {
  params: Promise<{ caseId: string }>;
}

/** Money and payout-hold actions run through their audited ops doors. */
const OPS_DOORS: Partial<
  Record<
    CaseAction["action"],
    (req: NextRequest, context: Context) => Promise<NextResponse>
  >
> = {
  REVIEW_REFUND: reviewSupportRefundDoor,
  VOID_RECOMMENDATION: voidSupportRecommendationDoor,
  APPLY_HOLD: applySupportHoldDoor,
  RELEASE_HOLD: releaseSupportHoldDoor,
};

export async function GET(_req: NextRequest, context: Context) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const parsed = Params.safeParse(await context.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid case" }, { status: 400 });
  const data = await readCaseResolution(parsed.data.caseId, {
    userId: auth.session.user.id,
    role: sessionRole(auth.session.user.role),
  });
  return data
    ? NextResponse.json({ data })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: NextRequest, context: Context) {
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;
  const params = Params.safeParse(await context.params);
  const parsed = CaseActionRequestSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success || !params.success)
    return NextResponse.json(
      {
        error:
          parsed.error?.issues.find((issue) => issue.code === "custom")
            ?.message ?? "Invalid action",
        code: "INVALID_ACTION",
      },
      { status: 400 },
    );
  const door = OPS_DOORS[parsed.data.action];
  if (door)
    return door(
      new NextRequest(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(parsed.data),
      }),
      context,
    );
  if (parsed.data.action === "DECIDE" && parsed.data.outcome === "OVERTURNED") {
    const stale = requireFreshSession(auth.session);
    if (stale) return stale;
  }
  try {
    const data = await performCaseAction(
      params.data.caseId,
      {
        userId: auth.session.user.id,
        role: sessionRole(auth.session.user.role),
        freshSession: isFreshSession(auth.session.session),
      },
      parsed.data,
    );
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof CaseActionError)
      return NextResponse.json(
        { error: error.message, code: error.code, ...error.detail },
        { status: error.status },
      );
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause: error,
      context: { route: "support.case.actions" },
    });
  }
}
