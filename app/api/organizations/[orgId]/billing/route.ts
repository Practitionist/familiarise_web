/**
 * GET /api/organizations/[orgId]/billing
 *
 * Aggregated billing snapshot for the unified Billing dashboard. All
 * sums are computed via DB-side `aggregate({ _sum })` so the response
 * stays O(1) regardless of org volume — no in-memory `.reduce` loops
 * over invoice/payment lists.
 *
 * Shape (consumed by `BillingPageClient.fetchBilling`):
 *   {
 *     fundingSource: FundingSource | null,
 *     monthToDate: { gross: number, paymentCount: number },
 *     outstanding: { amount: number, invoiceCount: number },
 *     pendingCharges: { amount: number, paymentCount: number } | null,
 *     paymentTermsDays: number,
 *   }
 *
 * `pendingCharges` is non-null only for INVOICE-funded orgs (where
 * Payment rows accrue with `billableToOrgInvoiceId = null` until the
 * monthly cron rolls them into an OrganizationInvoice).
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MANAGER",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const billingAccount = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
    select: { id: true, fundingSource: true },
  });

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [monthAgg, outstandingAgg, pendingAgg] = await Promise.all([
    prisma.payment.aggregate({
      where: {
        organizationId: orgId,
        paymentStatus: "SUCCEEDED",
        createdAt: { gte: startOfMonth },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.organizationInvoice.aggregate({
      where: {
        organizationId: orgId,
        status: { in: ["ISSUED", "OVERDUE"] },
      },
      _sum: { totalPaise: true },
      _count: { _all: true },
    }),
    billingAccount?.fundingSource === "INVOICE"
      ? prisma.payment.aggregate({
          where: {
            organizationId: orgId,
            billingAccountId: billingAccount.id,
            billableToOrgInvoiceId: null,
            paymentStatus: "SUCCEEDED",
          },
          _sum: { amount: true },
          _count: { _all: true },
        })
      : Promise.resolve(null),
  ]);

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { paymentTermsDays: true },
  });

  return NextResponse.json({
    fundingSource: billingAccount?.fundingSource ?? null,
    monthToDate: {
      gross: monthAgg._sum.amount ?? 0,
      paymentCount: monthAgg._count._all,
    },
    outstanding: {
      amount: outstandingAgg._sum.totalPaise ?? 0,
      invoiceCount: outstandingAgg._count._all,
    },
    pendingCharges: pendingAgg
      ? {
          amount: pendingAgg._sum.amount ?? 0,
          paymentCount: pendingAgg._count._all,
        }
      : null,
    paymentTermsDays: org?.paymentTermsDays ?? 60,
  });
}
