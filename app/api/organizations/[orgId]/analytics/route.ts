/**
 * GET /api/organizations/[orgId]/analytics
 *
 * Dashboard aggregate endpoint — the one call the org-home page makes to
 * render every stat tile. Returns an object keyed by section so the client
 * can lay out cards without extra round-trips:
 *
 *   capabilities  { canSponsor, canHost, fundingSource, walletBalance }
 *   members       { total, active, byRole }
 *   programs      { total, active, activeAssignments }
 *   wallet        { balancePaise, recentTopUps, recentDebits } (WALLET only)
 *   invoices      { outstanding, pastDue, paidLast30d }        (INVOICE only)
 *   earnings      { pending, ready, paid, refunded }           (canHost only)
 *
 * All aggregates are `count` / `_sum` queries — no per-row enumeration —
 * so the response stays cheap even for orgs with tens of thousands of rows.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      canSponsor: true,
      canHost: true,
      billingAccount: {
        select: { fundingSource: true, walletBalance: true, currency: true },
      },
    },
  });
  if (!org) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);
  const baId = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
    select: { id: true },
  });

  const [
    memberAggregate,
    memberByRole,
    programTotal,
    activeAssignments,
    recentWallet,
    outstandingInvoiceAgg,
    paidInvoiceAgg,
    pastDueInvoiceCount,
    earningsAggregate,
  ] = await Promise.all([
    prisma.membership.groupBy({
      by: ["status"],
      where: { organizationId: orgId },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["role"],
      where: { organizationId: orgId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    prisma.program.groupBy({
      by: ["status"],
      where: { contract: { organizationId: orgId } },
      _count: { _all: true },
    }),
    prisma.programAssignment.count({
      where: {
        program: { contract: { organizationId: orgId } },
        periodEnd: { gte: new Date() },
      },
    }),
    org.billingAccount?.fundingSource === "WALLET" && baId
      ? prisma.walletEntry.groupBy({
          by: ["reason"],
          where: {
            billingAccountId: baId.id,
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { deltaPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.aggregate({
          where: {
            billingAccountId: baId.id,
            status: { in: ["ISSUED", "OVERDUE"] },
          },
          _sum: { totalPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.aggregate({
          where: {
            billingAccountId: baId.id,
            status: "PAID",
            paidAt: { gte: thirtyDaysAgo },
          },
          _sum: { totalPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
    org.billingAccount?.fundingSource === "INVOICE" && baId
      ? prisma.organizationInvoice.count({
          where: {
            billingAccountId: baId.id,
            status: "OVERDUE",
          },
        })
      : Promise.resolve(0),
    org.canHost
      ? prisma.organizationEarnings.groupBy({
          by: ["status"],
          where: { organizationId: orgId },
          _sum: { orgSharePaise: true, refundedAmountPaise: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const memberTotal = memberAggregate.reduce(
    (acc, s) => acc + s._count._all,
    0,
  );
  const memberActive =
    memberAggregate.find((s) => s.status === "ACTIVE")?._count._all ?? 0;

  const programActive =
    programTotal.find((p) => p.status === "ACTIVE")?._count._all ?? 0;
  const programTotalCount = programTotal.reduce(
    (acc, s) => acc + s._count._all,
    0,
  );

  return NextResponse.json({
    capabilities: {
      canSponsor: org.canSponsor,
      canHost: org.canHost,
      fundingSource: org.billingAccount?.fundingSource ?? null,
      walletBalance: org.billingAccount?.walletBalance ?? null,
      currency: org.billingAccount?.currency ?? null,
    },
    members: {
      total: memberTotal,
      active: memberActive,
      byRole: memberByRole.map((r) => ({
        role: r.role,
        count: r._count._all,
      })),
    },
    programs: {
      total: programTotalCount,
      active: programActive,
      activeAssignments,
    },
    wallet:
      org.billingAccount?.fundingSource === "WALLET"
        ? {
            balancePaise: org.billingAccount.walletBalance ?? 0,
            recent: recentWallet.map((r) => ({
              reason: r.reason,
              count: r._count._all,
              deltaPaise: r._sum.deltaPaise ?? 0,
            })),
          }
        : null,
    invoices:
      org.billingAccount?.fundingSource === "INVOICE"
        ? {
            outstandingCount: outstandingInvoiceAgg?._count._all ?? 0,
            outstandingPaise: outstandingInvoiceAgg?._sum.totalPaise ?? 0,
            pastDueCount: pastDueInvoiceCount,
            paidLast30dCount: paidInvoiceAgg?._count._all ?? 0,
            paidLast30dPaise: paidInvoiceAgg?._sum.totalPaise ?? 0,
          }
        : null,
    earnings: org.canHost
      ? earningsAggregate.map((e) => ({
          status: e.status,
          count: e._count._all,
          orgSharePaise: e._sum.orgSharePaise ?? 0,
          refundedPaise: e._sum.refundedAmountPaise ?? 0,
        }))
      : null,
  });
}
