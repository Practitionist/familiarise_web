/**
 * GET  /api/organizations/[orgId]/payouts
 * POST /api/organizations/[orgId]/payouts
 *
 * Hosting-side settlements: roll READY earnings into an `OrganizationPayout`
 * row. The creation path is deliberately admin-gated and narrow:
 *   1. Pick all READY earnings in [periodStart, periodEnd).
 *   2. Create the payout with aggregated totals (gross/fee/refunds/net).
 *   3. Attach those earnings to the payout + flip their status to PAID.
 *
 * Actual fund-movement (RazorpayX / Cashfree) happens asynchronously in
 * jobs/payouts/** — this endpoint only records the intent and reserves the
 * earnings. `status` starts at `PENDING` and transitions via that job.
 *
 * India statutory fields (`tdsAmountPaise`, `mustPayByDate`, …) are nullable
 * at creation and filled by the cron; the route accepts hints but does not
 * derive them.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
// Why: payout initiation is a finance-team action; downgrade from
// requireOrgOwner so BILLING_ADMIN can trigger payouts without escalation.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

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
  "LEMON_SQUEEZY",
  "XFLOW",
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
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
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

  const payouts = await prisma.organizationPayout.findMany({
    where: {
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
    },
    orderBy: { createdAt: "desc" },
    take: q.limit,
    include: {
      _count: { select: { earnings: true } },
    },
  });

  return NextResponse.json({ data: payouts });
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
      //   (4) Flip the claimed rows READY → PAID in the same tx.
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
          acc.platformFee += e.platformFeePaise;
          acc.orgShare += e.orgSharePaise;
          acc.refunds += e.refundedAmountPaise;
          return acc;
        },
        { gross: 0, platformFee: 0, orgShare: 0, refunds: 0 },
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
          platformFeePaise: totals.platformFee,
          refundsPaise: totals.refunds,
          netPayoutPaise: netPayout,
        },
      });

      // Flip the claimed earnings READY → PAID. The cron that flips the
      // payout to COMPLETED does not touch earnings.status.
      await tx.organizationEarnings.updateMany({
        where: { orgPayoutId: created.id, status: "READY" },
        data: { status: "PAID" },
      });

      await tx.settlementLedgerEntry.create({
        data: {
          organizationId: orgId,
          payoutId: created.id,
          kind: "PAYOUT_SENT",
          amountPaise: -netPayout,
          currency: first.currency,
          notes:
            body.notes ??
            `Payout initiated — ${readyEarnings.length} earnings rolled up`,
        },
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
            platformFeePaise: totals.platformFee,
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
    throw err;
  }
}
