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

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { sumPaise } from "@/lib/payments/utils/money";

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
    // #777 §B — creditLimit drives the INVOICE credit-limit visibility line.
    select: { id: true, fundingSource: true, creditLimit: true },
  });

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [monthAgg, outstandingAgg, pendingAgg, licenseContract] =
    await Promise.all([
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
      // Surface the active LICENSE contract + its BillingSubscription for
      // the Annual License panel on /billing. T5 (#756 GS-1) wires the
      // contract create flow to atomically insert a BillingSubscription;
      // this is the read side that displays it. We explicitly filter to
      // contracts that HAVE a subscription — an org with multiple ACTIVE
      // LICENSE contracts (e.g. older fee-less ones alongside a newer one
      // that captured the fee) should show the one with the actual
      // commercial value, not whichever has the most recent effectiveFrom.
      billingAccount?.fundingSource === "LICENSE"
        ? prisma.contract.findFirst({
            where: {
              organizationId: orgId,
              status: "ACTIVE",
              subscription: { isNot: null },
            },
            orderBy: { effectiveFrom: "desc" },
            select: {
              id: true,
              effectiveFrom: true,
              effectiveTo: true,
              autoRenew: true,
              subscription: {
                select: {
                  model: true,
                  cycle: true,
                  flatFeePaise: true,
                  currentCycleStart: true,
                  currentCycleEnd: true,
                  nextInvoiceDate: true,
                },
              },
            },
          })
        : Promise.resolve(null),
    ]);

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { paymentTermsDays: true },
  });

  return NextResponse.json({
    fundingSource: billingAccount?.fundingSource ?? null,
    // null = unlimited (#777 §B credit-limit visibility).
    creditLimitPaise: billingAccount?.creditLimit ?? null,
    monthToDate: {
      gross: sumPaise(monthAgg._sum.amount),
      paymentCount: monthAgg._count._all,
    },
    outstanding: {
      amount: sumPaise(outstandingAgg._sum.totalPaise),
      invoiceCount: outstandingAgg._count._all,
    },
    pendingCharges: pendingAgg
      ? {
          amount: sumPaise(pendingAgg._sum.amount),
          paymentCount: pendingAgg._count._all,
        }
      : null,
    paymentTermsDays: org?.paymentTermsDays ?? 60,
    licenseContract: licenseContract
      ? {
          id: licenseContract.id,
          effectiveFrom: licenseContract.effectiveFrom.toISOString(),
          effectiveTo: licenseContract.effectiveTo?.toISOString() ?? null,
          autoRenew: licenseContract.autoRenew,
          subscription: licenseContract.subscription
            ? {
                model: licenseContract.subscription.model,
                cycle: licenseContract.subscription.cycle,
                flatFeePaise: licenseContract.subscription.flatFeePaise,
                currentCycleStart:
                  licenseContract.subscription.currentCycleStart.toISOString(),
                currentCycleEnd:
                  licenseContract.subscription.currentCycleEnd.toISOString(),
                nextInvoiceDate:
                  licenseContract.subscription.nextInvoiceDate.toISOString(),
              }
            : null,
        }
      : null,
  });
}
