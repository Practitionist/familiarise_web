/** Organization chargebacks include buyer funding and host earnings, with funding-private details redacted for hosts. */
import { NextResponse, type NextRequest } from "next/server";
import { DisputeStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { sumPaise } from "@/lib/payments/utils/money";

const QuerySchema = z.object({
  status: z.nativeEnum(DisputeStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "disputes.read",
  });
  if (access.error) return access.error;

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsed.data;
  const scope = {
    payment: {
      OR: [
        { organizationId: orgId },
        { hostOrganizationId: orgId },
        { organizationEarnings: { some: { organizationId: orgId } } },
      ],
    },
  } satisfies Prisma.DisputeWhereInput;
  const where = { ...scope, ...(q.status && { status: q.status }) };
  const [disputes, total, allCount, openCount, lostAmounts] = await Promise.all(
    [
      prisma.dispute.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit,
        skip: q.offset,
        select: {
          id: true,
          disputeId: true,
          amountPaise: true,
          currency: true,
          reason: true,
          status: true,
          dueBy: true,
          createdAt: true,
          updatedAt: true,
          payment: {
            select: {
              id: true,
              organizationId: true,
              hostOrganizationId: true,
              organizationEarnings: {
                where: { organizationId: orgId },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      }),
      prisma.dispute.count({ where }),
      prisma.dispute.count({ where: scope }),
      prisma.dispute.count({
        where: { ...scope, status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
      }),
      prisma.dispute.groupBy({
        by: ["currency"],
        where: { ...scope, status: { in: ["LOST", "CHARGE_REFUNDED"] } },
        _sum: { amountPaise: true },
      }),
    ],
  );

  return NextResponse.json({
    data: disputes.map(({ payment, reason, ...dispute }) => {
      const buyer = payment.organizationId === orgId;
      const host =
        payment.hostOrganizationId === orgId ||
        payment.organizationEarnings.length > 0;
      return {
        ...dispute,
        reason: buyer ? reason : null,
        payment: buyer ? { id: payment.id } : null,
        relationship: buyer ? (host ? "BUYER_AND_HOST" : "BUYER") : "HOST",
      };
    }),
    pagination: {
      total,
      limit: q.limit,
      offset: q.offset,
      hasMore: q.offset + disputes.length < total,
    },
    stats: {
      totalCount: allCount,
      openCount,
      lostAmounts: lostAmounts.map((row) => ({
        currency: row.currency,
        amountPaise: sumPaise(row._sum.amountPaise),
      })),
    },
  });
}
