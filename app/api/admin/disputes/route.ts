import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { OPEN_DISPUTE_WHERE } from "@/lib/backoffice/queue-predicates";
import { Prisma, DisputeStatus, PaymentGateway } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

const ACTIONABLE_OPEN_STATUSES: DisputeStatus[] = [
  "NEEDS_RESPONSE",
  "WARNING_NEEDS_RESPONSE",
];

const DISPUTE_PAYMENT_INCLUDE = {
  payment: {
    select: {
      id: true,
      paymentIntent: true,
    },
  },
} satisfies Prisma.DisputeInclude;

async function loadDisputePage(params: {
  where: Prisma.DisputeWhereInput;
  status: DisputeStatus | null;
  skip: number;
  limit: number;
}) {
  const { where, status, skip, limit } = params;
  if (status) {
    const isActionableOpen = ACTIONABLE_OPEN_STATUSES.includes(status);
    return prisma.dispute.findMany({
      where,
      skip,
      take: limit,
      orderBy: isActionableOpen
        ? [{ dueBy: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }]
        : [{ createdAt: "desc" }],
      include: DISPUTE_PAYMENT_INCLUDE,
    });
  }

  const openWhere: Prisma.DisputeWhereInput = {
    ...where,
    status: { in: ACTIONABLE_OPEN_STATUSES },
  };
  const closedWhere: Prisma.DisputeWhereInput = {
    ...where,
    status: { notIn: ACTIONABLE_OPEN_STATUSES },
  };
  const openCount = await prisma.dispute.count({ where: openWhere });
  const openTake = Math.max(0, Math.min(limit, openCount - skip));
  const closedTake = limit - openTake;
  const closedSkip = Math.max(0, skip - openCount);

  const [openDisputes, closedDisputes] = await Promise.all([
    openTake > 0
      ? prisma.dispute.findMany({
          where: openWhere,
          skip,
          take: openTake,
          orderBy: [
            { dueBy: { sort: "asc", nulls: "last" } },
            { createdAt: "desc" },
          ],
          include: DISPUTE_PAYMENT_INCLUDE,
        })
      : Promise.resolve([]),
    closedTake > 0
      ? prisma.dispute.findMany({
          where: closedWhere,
          skip: closedSkip,
          take: closedTake,
          orderBy: [{ createdAt: "desc" }],
          include: DISPUTE_PAYMENT_INCLUDE,
        })
      : Promise.resolve([]),
  ]);

  return [...openDisputes, ...closedDisputes];
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const searchParams = req.nextUrl.searchParams;
    const rawPage = Number.parseInt(searchParams.get("page") || "1", 10);
    const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
    const rawLimit = Number.parseInt(searchParams.get("limit") || "20", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(100, Math.max(1, rawLimit))
      : 20;
    const status = searchParams.get("status") as DisputeStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const search = searchParams.get("search");
    const orgId = searchParams.get("orgId");

    const where: Prisma.DisputeWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.disputeId = {
        contains: search,
        mode: "insensitive",
      };
    }

    if (orgId) {
      where.payment = { is: { organizationId: orgId } };
    }

    const skip = (page - 1) * limit;

    const [total, urgentDisputes, underReviewCount, wonCount, disputes] =
      await Promise.all([
        prisma.dispute.count({ where }),
        prisma.dispute.count({
          where: {
            dueBy: {
              lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
              gte: new Date(),
            },
            ...OPEN_DISPUTE_WHERE,
          },
        }),
        prisma.dispute.count({ where: { status: "UNDER_REVIEW" } }),
        prisma.dispute.count({ where: { status: "WON" } }),
        loadDisputePage({ where, status, skip, limit }),
      ]);

    return NextResponse.json({
      disputes,
      total,
      urgentDisputes,
      stats: { underReviewCount, wonCount },
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Admin disputes list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch disputes" },
      { status: 500 },
    );
  }
}
