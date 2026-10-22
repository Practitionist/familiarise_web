import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
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
import { sessionRole } from "@/lib/auth/session-role";

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

function buildTurnAppendParams(params: {
  caseId: string;
  userId: string;
  staff: boolean;
  data: z.infer<typeof PostMessageBodySchema>;
}) {
  const { caseId, userId, staff, data } = params;
  return {
    caseId,
    authorUserId: userId,
    sender: staff ? ("AGENT" as const) : ("USER" as const),
    body: data.body,
    isInternal: staff ? data.isInternal : false,
    clientTurnId: data.clientTurnId,
    expectedLastMessageAt: staff ? data.expectedLastMessageAt : undefined,
    // Operators reopen through the case status, never through a reply.
    reopen: staff ? undefined : data.reopen,
  };
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
    const staff = hasBackofficePermission(
      sessionRole(user.role),
      "tickets.manage",
    );

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
      role: sessionRole(user.role),
      canReadPayments: hasBackofficePermission(
        sessionRole(user.role),
        "payments.read",
      ),
      canReadContact: hasBackofficePermission(
        sessionRole(user.role),
        "users.read",
      ),
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

    const result = await appendSupportCaseTurn(
      buildTurnAppendParams({
        caseId,
        userId: user.id,
        staff,
        data: parsed.data,
      }),
    );

    if (!result.ok) {
      const { ok: _ok, status, ...body } = result;
      return NextResponse.json(body, { status });
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

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const id = await parseRouteParams(CaseIdParamsSchema, params, {
    route: "support.case.messages",
  });
  if (!id.ok) return id.response;
  const user = auth.session.user;
  const staff = hasBackofficePermission(
    sessionRole(user.role),
    "tickets.manage",
  );
  const access = await readSupportCaseForViewer(id.data.caseId, {
    userId: user.id,
    role: sessionRole(user.role),
    isStaff: staff,
  });
  if (!access || access.filedByOrganizationNotice)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const input = z
    .object({
      beforeSeq: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(200),
    })
    .safeParse({
      beforeSeq: req.nextUrl.searchParams.get("beforeSeq") ?? undefined,
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    });
  if (!input.success)
    return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
  const rows = await prisma.supportCaseMessage.findMany({
    where: {
      caseId: id.data.caseId,
      ...(!staff ? { isInternal: false } : {}),
      ...(input.data.beforeSeq ? { seq: { lt: input.data.beforeSeq } } : {}),
    },
    orderBy: { seq: "asc" },
    take: -(input.data.limit + 1),
    select: {
      id: true,
      seq: true,
      sender: true,
      body: true,
      isInternal: true,
      createdAt: true,
    },
  });
  const data = rows.slice(-input.data.limit);
  return NextResponse.json(
    {
      data,
      hasMore: rows.length > input.data.limit,
      nextBeforeSeq: data[0]?.seq ?? null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
