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

const CaseIdParamsSchema = z.object({
  caseId: z.string().min(1).max(64),
});

const PostMessageBodySchema = AppendSupportCaseTurnSchema.omit({
  caseId: true,
  authorUserId: true,
  sender: true,
});

/**
 * The cursor for paging backwards through a case's transcript. `beforeSeq` is
 * exclusive: the page returns messages with a sequence BELOW it.
 */
const TimelineQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
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
  };
}

/**
 * One page of the transcript, oldest-first, paging BACKWARDS.
 *
 * The case page renders the newest messages and offers "load older". The
 * cursor is the message sequence, exclusive, so a page boundary never shows
 * the same message twice.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(CaseIdParamsSchema, params, {
    route: "support.case.messages",
  });
  if (!id.ok) return id.response;
  const { caseId } = id.data;

  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { user } = auth.session;
  const staff = hasBackofficePermission(user.role, "tickets.manage");

  const query = TimelineQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!query.success) {
    return supportError({ status: 400, code: "VALIDATION_FAILED" });
  }

  const access = await readSupportCaseForViewer(caseId, {
    userId: user.id,
    isStaff: staff,
    role: user.role,
    canReadPayments: hasBackofficePermission(user.role, "payments.read"),
    canReadContact: hasBackofficePermission(user.role, "users.read"),
  });
  if (!access || access.filedByOrganizationNotice) {
    return supportError({ status: 404, code: "NOT_FOUND" });
  }

  const { beforeSeq, limit } = query.data;
  // One over the limit, so the reader can tell "there are more" from "this
  // is the last page" without a second count.
  const rows = await prisma.supportCaseMessage.findMany({
    where: {
      caseId,
      ...(staff ? {} : { isInternal: false }),
      ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }),
    },
    orderBy: { seq: "desc" },
    take: limit + 1,
    select: {
      id: true,
      seq: true,
      sender: true,
      body: true,
      isInternal: true,
      createdAt: true,
      authorUserId: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();

  return NextResponse.json(
    {
      data: staff
        ? page
        : page.map(({ isInternal: _isInternal, ...message }) => message),
      // The cursor is EXCLUSIVE, so it is the OLDEST message on this page:
      // the next request asks for everything below it. The newest message on
      // the page would return this same page again.
      nextBeforeSeq: hasMore ? (page[0]?.seq ?? null) : null,
      hasMore,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
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
    const staff = hasBackofficePermission(user.role, "tickets.manage");

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
      role: user.role,
      canReadPayments: hasBackofficePermission(user.role, "payments.read"),
      canReadContact: hasBackofficePermission(user.role, "users.read"),
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
