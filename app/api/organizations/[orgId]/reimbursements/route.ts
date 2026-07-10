/**
 * GET /api/organizations/[orgId]/reimbursements
 *
 * C4: lists Payments tagged to the org where the org's BillingAccount
 * is on PERSONAL fundingSource — i.e., members paid out of pocket and
 * the org needs a reimbursement report. MANAGER+ at the org.
 *
 * Returns rows + per-member totals in INR paise. CSV export lives at
 * `/export/route.ts`.
 *
 * Query params:
 *   - `from`, `to` — ISO date range (inclusive)
 *   - `userId` — filter to a single member
 *   - `page`, `perPage` — pagination
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { parsePagination } from "@/lib/enterprise/validators";
import { sumPaise } from "@/lib/payments/utils/money";

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "reimbursements.read" });
  if (access.error) return access.error;

  // Conditional render: only orgs whose BillingAccount.fundingSource is
  // PERSONAL get reimbursement views. Other funding modes (WALLET,
  // INVOICE, LICENSE) settle through their own dashboards.
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { ownerOrgId: orgId },
    select: { fundingSource: true },
  });
  if (!billingAccount || billingAccount.fundingSource !== "PERSONAL") {
    return NextResponse.json(
      {
        error:
          "Reimbursements view is only available for organizations on PERSONAL funding.",
      },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const filters = QuerySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    userId: url.searchParams.get("userId") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }
  const pagination = parsePagination(url);

  const where = {
    organizationId: orgId,
    paymentStatus: "SUCCEEDED" as const,
    ...(filters.data.userId && { userId: filters.data.userId }),
    ...(filters.data.from || filters.data.to
      ? {
          createdAt: {
            ...(filters.data.from && { gte: new Date(filters.data.from) }),
            ...(filters.data.to && { lte: new Date(filters.data.to) }),
          },
        }
      : {}),
  };

  const [total, items, totalPaiseAgg] = await prisma.$transaction([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: pagination.pageSize,
      skip: (pagination.page - 1) * pagination.pageSize,
    }),
    prisma.payment.aggregate({
      where,
      _sum: { amount: true },
    }),
  ]);
  // groupBy lives outside the $transaction tuple — Prisma 7's
  // groupBy/aggregate types don't compose into the array tuple cleanly.
  const byMember = await prisma.payment.groupBy({
    by: ["userId"],
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  // Hydrate member names for the by-member roll-up.
  const userIds = byMember.map((b) => b.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    items,
    total,
    page: pagination.page,
    perPage: pagination.pageSize,
    totalPaise: sumPaise(totalPaiseAgg._sum.amount),
    byMember: byMember.map((b) => ({
      userId: b.userId,
      name: userMap.get(b.userId)?.name ?? null,
      email: userMap.get(b.userId)?.email ?? null,
      totalPaise: sumPaise(b._sum?.amount),
      paymentCount:
        typeof b._count === "object" && b._count
          ? ((b._count as { _all?: number })._all ?? 0)
          : 0,
    })),
  });
}
