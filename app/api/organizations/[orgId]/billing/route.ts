/**
 * Org billing summary — high-level stats card data for the billing dashboard.
 *
 * GET — ORG_MANAGER+; returns this-month gross, outstanding invoice total,
 * billing mode, and (for SEAT_PACK orgs) credit pool snapshot. Cheap aggregate
 * query — keep it lean. Detail breakdowns live in /billing/invoices and
 * /credits.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_MANAGER");
    if (access.error) return access.error;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      monthAggregate,
      outstandingAggregate,
      pendingChargesAggregate,
      creditPool,
    ] = await Promise.all([
      // This month's gross — only succeeded payments tagged to this org.
      prisma.payment.aggregate({
        where: {
          organizationProfileId: access.org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
        _count: true,
      }),

      // Outstanding invoices: SENT or OVERDUE.
      prisma.organizationInvoice.aggregate({
        where: {
          organizationProfileId: access.org.id,
          status: { in: ["SENT", "OVERDUE"] },
        },
        _sum: { amount: true },
        _count: true,
      }),

      // INVOICED_MONTHLY pending charges: net of refunds.
      access.org.billingMode === "INVOICED_MONTHLY"
        ? prisma.payment.findMany({
            where: {
              organizationProfileId: access.org.id,
              paymentStatus: "SUCCEEDED",
              paymentMethod: "ORG_INVOICED",
              billableToOrgInvoiceId: null,
            },
            select: {
              amount: true,
              refunds: {
                where: { status: "SUCCEEDED" },
                select: { amount: true },
              },
            },
          })
        : Promise.resolve(null),

      // SEAT_PACK credit pool snapshot.
      access.org.billingMode === "SEAT_PACK"
        ? prisma.orgCreditPool.findUnique({
            where: { organizationProfileId: access.org.id },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      billingMode: access.org.billingMode,
      currency: "INR",
      monthToDate: {
        gross: monthAggregate._sum.amount ?? 0,
        paymentCount: monthAggregate._count,
      },
      outstanding: {
        amount: outstandingAggregate._sum.amount ?? 0,
        invoiceCount: outstandingAggregate._count,
      },
      pendingCharges: pendingChargesAggregate
        ? (() => {
            const payments = pendingChargesAggregate as Array<{
              amount: number;
              refunds: Array<{ amount: number }>;
            }>;
            const netAmount = payments.reduce((sum, p) => {
              const refunded = p.refunds.reduce((s, r) => s + r.amount, 0);
              return sum + Math.max(0, (p.amount ?? 0) - refunded);
            }, 0);
            return {
              amount: netAmount,
              paymentCount: payments.length,
            };
          })()
        : null,
      creditPool: creditPool
        ? {
            balance: creditPool.balance,
            totalPurchased: creditPool.totalPurchased,
          }
        : null,
      orgInvoiceCreditLimit: access.org.orgInvoiceCreditLimit,
      paymentTermsDays: access.org.paymentTermsDays,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/billing GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch billing summary" },
      { status: 500 },
    );
  }
}
