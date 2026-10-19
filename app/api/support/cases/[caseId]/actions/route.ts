import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth-helpers";
import { requireFreshSession } from "@/lib/auth/step-up";
import {
  CaseActionError,
  CaseActionSchema,
  performCaseAction,
  readCaseResolution,
} from "@/lib/support/case-actions";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";

const Params = z.object({ caseId: z.string().min(1).max(64) });
interface Context {
  params: Promise<{ caseId: string }>;
}

export async function GET(_req: NextRequest, context: Context) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const parsed = Params.safeParse(await context.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid case" }, { status: 400 });
  const data = await readCaseResolution(parsed.data.caseId, {
    userId: auth.session.user.id,
    role: auth.session.user.role,
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
  const parsed = CaseActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !params.success)
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  if (
    ["REVIEW_REFUND", "APPLY_HOLD", "RELEASE_HOLD"].includes(
      parsed.data.action,
    ) ||
    (parsed.data.action === "DECIDE" && parsed.data.outcome === "OVERTURNED")
  ) {
    const stale = requireFreshSession(auth.session);
    if (stale) return stale;
  }
  try {
    const data = await performCaseAction(
      params.data.caseId,
      { userId: auth.session.user.id, role: auth.session.user.role },
      parsed.data,
    );
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof CaseActionError)
      return NextResponse.json(
        { error: error.message, code: error.code },
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
