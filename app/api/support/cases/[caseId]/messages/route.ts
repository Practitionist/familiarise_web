import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import {
  spamLimiter as ticketResponseLimiter,
  applyRateLimit,
} from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import {
  AppendSupportCaseTurnSchema,
  appendSupportCaseTurn,
  readSupportCaseForViewer,
} from "@/lib/support/case-service";

const CaseIdParamsSchema = z.object({
  caseId: z.string().min(1).max(64),
});

const PostMessageBodySchema = AppendSupportCaseTurnSchema.omit({
  caseId: true,
  authorUserId: true,
  sender: true,
});

interface RouteParams {
  params: Promise<{ caseId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(CaseIdParamsSchema, params, {
    route: "support.case.messages",
  });
  if (!id.ok) return id.response;
  const { caseId } = id.data;

  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = isPrivileged(user.role);

    if (!staff) {
      const rl = await applyRateLimit(
        ticketResponseLimiter,
        `ticket-response:${user.id}`,
      );
      if (rl) return rl;
    }

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const access = await readSupportCaseForViewer(caseId, {
      userId: user.id,
      isStaff: staff,
    });
    if (!access || access.filedByOrganizationNotice) {
      return NextResponse.json(
        { error: "Support case not found" },
        { status: 404 },
      );
    }

    const parsed = PostMessageBodySchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "support.case.messages", action: "create", caseId },
      });
    }

    if (parsed.data.isInternal && !staff) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await appendSupportCaseTurn({
      caseId,
      authorUserId: user.id,
      sender: staff ? "AGENT" : "USER",
      body: parsed.data.body,
      isInternal: staff ? parsed.data.isInternal : false,
      clientTurnId: parsed.data.clientTurnId,
      expectedLastMessageAt: staff
        ? parsed.data.expectedLastMessageAt
        : undefined,
    });

    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json(
      { data: result.messages, replayed: result.replayed },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.case.messages", action: "create", caseId },
    });
  }
}
