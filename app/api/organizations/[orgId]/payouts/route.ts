/**
 * GET  /api/organizations/[orgId]/payouts
 * POST /api/organizations/[orgId]/payouts
 *
 * Hosting-side settlements: roll READY earnings into an `OrganizationPayout`
 * row. The creation path is deliberately admin-gated and narrow:
 *   1. Pick all READY earnings in [periodStart, periodEnd).
 *   2. Create the payout with aggregated totals (gross/fee/refunds/net).
 *   3. Attach those earnings to the payout + flip their status to BATCHED
 *      (#837 — not PAID; PAID happens only at payout COMPLETED + UTR).
 *
 * Actual fund-movement (RazorpayX / Cashfree) happens asynchronously in
 * jobs/payouts/** — this endpoint only records the intent and reserves the
 * earnings. `status` starts at `PENDING` and transitions via that job.
 *
 * India statutory fields (`tdsAmountPaise`, `mustPayByDate`, …) are nullable
 * at creation and filled by the cron; the route accepts hints but does not
 * derive them.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
// Why: payout initiation is a finance-team action; downgrade from
// requireOrgOwner so BILLING_ADMIN can trigger payouts without escalation.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { sumPaise } from "@/lib/payments/utils/money";
import type { PayoutStatus } from "@prisma/client";

const PayoutStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const PaymentGatewaySchema = z.enum([
  "STRIPE",
  "RAZORPAY",
  "CARD",
]);

const CreatePayoutBodySchema = z
  .object({
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    paymentGateway: PaymentGatewaySchema.default("RAZORPAY"),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.periodEnd.getTime() > v.periodStart.getTime(), {
    message: "periodEnd must be after periodStart",
  });

const QuerySchema = z.object({
  status: PayoutStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// In-flight = held/reserved but not yet disbursed (mirrors the client's
// former "Pending" card definition).
const IN_FLIGHT_STATUSES: PayoutStatus[] = ["PENDING", "APPROVED", "PROCESSING"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "payouts.read" });
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host — no payouts to list" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const parsedQuery = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsedQuery.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsedQuery.data;

  const where = {
    organizationId: orgId,
    ...(q.status && { status: q.status }),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from && { gte: q.from }),
            ...(q.to && { lt: q.to }),
          },
        }
      : {}),
  };

  // #997 secondary findings: this used to fetch every payout for the org
  // (no offset) and reduce totals client-side every render. Pagination now
  // bounds the list; `stats` below is server-aggregated and org-wide
  // (ignores status/date filters) so the summary cards don't shift as the
  // table is filtered/paged — matching the client's original "stay on the
  // full set" intent.
  const [payouts, total, paidAgg, pendingAgg, statusCounts] =
    await Promise.all([
      prisma.organizationPayout.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
        skip: q.offset,
        include: {
          _count: { select: { earnings: true } },
        },
      }),
      prisma.organizationPayout.count({ where }),
      prisma.organizationPayout.aggregate({
        where: { organizationId: orgId, status: "COMPLETED" },
        _sum: { netPayoutPaise: true },
      }),
      prisma.organizationPayout.aggregate({
        where: { organizationId: orgId, status: { in: IN_FLIGHT_STATUSES } },
        _sum: { netPayoutPaise: true },
      }),
      prisma.organizationPayout.groupBy({
        by: ["status"],
        where: { organizationId: orgId },
        _count: { id: true },
      }),
    ]);

  const counts = Object.fromEntries(
    statusCounts.map((s) => [s.status, s._count.id]),
  ) as Partial<Record<PayoutStatus, number>>;
  const totalCount = statusCounts.reduce((sum, s) => sum + s._count.id, 0);

  return NextResponse.json({
    data: payouts,
    pagination: {
      total,
      limit: q.limit,
      offset: q.offset,
      hasMore: q.offset + q.limit < total,
    },
    stats: {
      totalPaidPaise: sumPaise(paidAgg._sum.netPayoutPaise),
      pendingPaise: sumPaise(pendingAgg._sum.netPayoutPaise),
      counts: { ...counts, total: totalCount },
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host — payouts are unavailable" },
      { status: 409 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = CreatePayoutBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const payout = await prisma.$transaction(async (tx) => {
      // Require a verified payout account. An unverified account means
      // the side-channel hasn't finished provisioning RazorpayX contact +
      // fund-account, so fund movement cannot actually succeed.
      const payoutAccount = await tx.organizationPayoutAccount.findUnique({
        where: { organizationId: orgId },
      });
      if (!payoutAccount) {
        throw Object.assign(
          new Error("No payout account configured for this organization"),
          { httpStatus: 409 },
        );
      }
      if (payoutAccount.status !== "VERIFIED") {
        throw Object.assign(
          new Error(
            `Payout account is ${payoutAccount.status} — cannot create payouts until VERIFIED`,
          ),
          { httpStatus: 409 },
        );
      }

      // Race-safe claim pattern:
      //   (1) Create the payout row first (with zero totals as placeholders).
      //   (2) Atomically claim READY earnings by assigning them orgPayoutId
      //       in a single UPDATE — Postgres' row-level locks serialise any
      //       concurrent POST, so two requests can never claim the same
      //       earning.
      //   (3) Re-read the claimed rows (authoritatively scoped by orgPayoutId),
      //       compute totals, and patch the payout row with the real numbers.
      //   (4) Flip the claimed rows READY → BATCHED in the same tx (#837).
      // If no rows are claimed, throw to abort the tx so the placeholder
      // payout row is rolled back too.
      const created = await tx.organizationPayout.create({
        data: {
          organizationId: orgId,
          amountPaise: 0,
          currency: "INR",
          status: "PENDING",
          paymentGateway: body.paymentGateway,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          grossRevenuePaise: 0,
          platformFeePaise: 0,
          refundsPaise: 0,
          netPayoutPaise: 0,
        },
      });

      const claim = await tx.organizationEarnings.updateMany({
        where: {
          organizationId: orgId,
          status: "READY",
          orgPayoutId: null,
          createdAt: { gte: body.periodStart, lt: body.periodEnd },
        },
        data: { orgPayoutId: created.id },
      });
      if (claim.count === 0) {
        throw Object.assign(
          new Error("No READY earnings in the requested window"),
          { httpStatus: 409 },
        );
      }

      const readyEarnings = await tx.organizationEarnings.findMany({
        where: { orgPayoutId: created.id },
        select: {
          id: true,
          grossAmountPaise: true,
          platformFeePaise: true,
          orgSharePaise: true,
          refundedAmountPaise: true,
          currency: true,
        },
      });

      const first = readyEarnings[0];
      if (!first) {
        throw Object.assign(
          new Error("No READY earnings in the requested window"),
          { httpStatus: 409 },
        );
      }
      const mixedCurrency = readyEarnings.some(
        (e) => e.currency !== first.currency,
      );
      if (mixedCurrency) {
        throw Object.assign(
          new Error(
            "Cannot roll earnings in mixed currencies into a single payout. Split the window.",
          ),
          { httpStatus: 409 },
        );
      }

      const totals = readyEarnings.reduce(
        (acc, e) => {
          acc.gross += e.grossAmountPaise;
          acc.platformFeePaise += e.platformFeePaise;
          acc.orgShare += e.orgSharePaise;
          acc.refunds += e.refundedAmountPaise;
          return acc;
        },
        { gross: 0, platformFeePaise: 0, orgShare: 0, refunds: 0 },
      );
      // Net payout to the org = orgShare - refunds. TDS is withheld by
      // the cron if applicable, so this is the PRE-tax net.
      const netPayout = totals.orgShare - totals.refunds;
      if (netPayout <= 0) {
        throw Object.assign(
          new Error(
            `Net payout would be ${netPayout} paise — refunds exceed earnings. Reconcile first.`,
          ),
          { httpStatus: 409 },
        );
      }

      const updated = await tx.organizationPayout.update({
        where: { id: created.id },
        data: {
          amountPaise: netPayout,
          currency: first.currency,
          grossRevenuePaise: totals.gross,
          platformFeePaise: totals.platformFeePaise,
          refundsPaise: totals.refunds,
          netPayoutPaise: netPayout,
        },
      });

      // #837 E-03/E-04 — batch creation only STAGES the earnings; cash has not
      // left. Flip READY → BATCHED, not PAID. markOrgPayoutCompleted performs
      // the BATCHED → PAID flip when the payout reaches COMPLETED (+ UTR).
      await tx.organizationEarnings.updateMany({
        where: { orgPayoutId: created.id, status: "READY" },
        data: { status: "BATCHED" },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "PAYOUT",
          action: AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
          description: `Payout initiated: ${readyEarnings.length} earnings, net ${netPayout} paise ${first.currency}`,
          details: {
            payoutId: created.id,
            earningsCount: readyEarnings.length,
            netPayoutPaise: netPayout,
            grossPaise: totals.gross,
            platformFeePaise: totals.platformFeePaise,
            refundsPaise: totals.refunds,
          },
        },
      });

      return updated;
    });

    return NextResponse.json({ payout }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
