/**
 * Refunds API
 * Handles refund creation, retrieval, and listing
 */

import { createRefund, listRefunds } from "@/lib/payments";
import prisma from "@/lib/prisma";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/errors/classification/payment-error-classification";
import { Prisma } from "@prisma/client";
import { creditRefund } from "@/lib/payments/operations/org-credits";
import { refundEarnings } from "@/lib/payments/payouts";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
// ============================================================================
// Validation Schemas
// ============================================================================

const createRefundSchema = z.object({
  paymentId: z.string().min(1, "Payment ID is required"),
  amount: z.number().positive().optional(),
  reason: z.string().optional(),
  // NEW-1: When true, allows refunding even if consultant earnings are already paid out.
  // The platform absorbs the loss. Requires explicit admin acknowledgement.
  forceRefund: z.boolean().optional().default(false),
});

const _getRefundsSchema = z.object({
  paymentId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

// ============================================================================
// POST /api/payments/refunds - Create Refund
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    // Authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Admin/Staff check
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (user?.role !== "ADMIN" && user?.role !== "STAFF") {
      return NextResponse.json(
        { error: "Forbidden - Admin access required" },
        { status: 403 },
      );
    }

    // Validate request
    const body = await req.json();
    const { paymentId, amount, reason, forceRefund } =
      createRefundSchema.parse(body);

    // Fetch exchange rate for international payment audit (before transaction)
    let refundExchangeRate: number | null = null;
    let refundDisplayCurrency: string | null = null;

    const paymentForRateCheck = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { isInternational: true, displayCurrencyAtCheckout: true },
    });

    if (
      paymentForRateCheck?.isInternational &&
      paymentForRateCheck.displayCurrencyAtCheckout
    ) {
      refundDisplayCurrency = paymentForRateCheck.displayCurrencyAtCheckout;
      try {
        const { getExchangeRates } = await import("@/lib/currency");
        const rates = await getExchangeRates();
        refundExchangeRate = rates[refundDisplayCurrency] ?? null;
      } catch {
        console.warn("Failed to fetch exchange rate for refund audit");
      }
    }

    // ==========================================================================
    // TWO-PHASE REFUND PATTERN
    // ==========================================================================
    // Phase 1: Create PENDING refund record (claims the amount, prevents race conditions)
    // Phase 2: Call external payment gateway (outside transaction)
    // Phase 3: Update refund status based on gateway result
    //
    // This prevents:
    // - Double refunds (PENDING record claims the amount atomically)
    // - Long-running transactions (API call is outside)
    // - Data loss (we always have a record for reconciliation)
    // ==========================================================================

    // PHASE 1: Create PENDING refund record in a transaction
    // This atomically validates and claims the refund amount
    const phase1Result = await prisma.$transaction(async (tx) => {
      // Get payment with refunds and associated earnings inside transaction
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          user: { select: { id: true, email: true, name: true } },
          appointment: true,
          refunds: true,
          earnings: true,
          organizationProfile: {
            select: { id: true, billingMode: true },
          },
        },
      });

      if (!payment) {
        throw new Error("Payment not found");
      }

      if (payment.paymentStatus !== "SUCCEEDED") {
        throw new Error("Only successful payments can be refunded");
      }

      // NEW-1: Block refund if consultant earnings have already been paid out.
      // Once the consultant has received their payout, issuing a refund means
      // the platform absorbs the full loss. Require explicit forceRefund flag.
      if (
        payment.earnings.length > 0 &&
        payment.earnings.some((e) => e.status === "PAID") &&
        !forceRefund
      ) {
        throw new Error(
          "Cannot refund: consultant earnings have already been paid out. " +
            "Issuing this refund means the platform absorbs the loss. " +
            "Set forceRefund: true to proceed, or initiate a clawback from the consultant first.",
        );
      }

      // Calculate total already refunded (SUCCEEDED) + pending refunds (PENDING)
      // Including PENDING prevents race conditions - if another request created
      // a PENDING refund, we'll see it and fail validation
      const totalRefundedOrPending = payment.refunds
        .filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
        .reduce((sum, r) => sum + r.amount, 0);

      if (totalRefundedOrPending >= payment.amount) {
        throw new Error("Payment has already been fully refunded");
      }

      const refundAmount = amount || payment.amount - totalRefundedOrPending;

      if (refundAmount > payment.amount - totalRefundedOrPending) {
        throw new Error("Refund amount exceeds available balance");
      }

      // Create PENDING refund record - this "claims" the amount
      // Uses a placeholder refundId that will be updated after gateway call
      const pendingRefund = await tx.refund.create({
        data: {
          amount: refundAmount,
          currency: payment.currency,
          reason,
          status: "PENDING",
          refundId: `pending_${crypto.randomUUID()}`,
          paymentGateway: payment.paymentGateway,
          metadata: { forceRefund: forceRefund ?? false },
          exchangeRateAtRefund: refundExchangeRate,
          displayCurrency: refundDisplayCurrency,
          paymentId: payment.id,
        },
      });

      return { payment, pendingRefund, refundAmount };
    });

    const { payment, pendingRefund, refundAmount } = phase1Result;

    // PHASE 2: Route refund based on payment method
    //
    // Enterprise org billing modes:
    //   - ORG_CREDIT (SEAT_PACK): credit the pool back instead of calling
    //     the gateway. No real money movement — just a ledger reversal.
    //   - ORG_INVOICED (INVOICED_MONTHLY): if the invoice hasn't been paid
    //     yet, unbill the payment so it drops out of the next rollup. If
    //     already paid, mark as succeeded so the admin can issue a manual
    //     credit note on the next invoice cycle.
    //   - CARD / TAG_ONLY: normal gateway refund.
    let refundResult;
    const isOrgCreditRefund = payment.paymentMethod === "ORG_CREDIT";
    const isOrgInvoicedRefund = payment.paymentMethod === "ORG_INVOICED";

    if (isOrgCreditRefund && payment.organizationProfileId) {
      // SEAT_PACK: credit the pool back.
      await prisma.$transaction(async (tx) => {
        await creditRefund(
          tx,
          payment.organizationProfileId!,
          refundAmount,
          payment.id,
        );
      });
      refundResult = {
        refundId: `org_credit_refund_${crypto.randomUUID()}`,
        amount: refundAmount,
        currency: payment.currency,
        status: "SUCCEEDED" as const,
        metadata: { method: "ORG_CREDIT", poolCredited: true },
      };
    } else if (isOrgInvoicedRefund) {
      // INVOICED_MONTHLY: unbill the payment if invoice not yet paid.
      // TODO(billing): When the payment is already attached to a PAID invoice,
      // this only unbills it — the OrganizationInvoice.amount and items are NOT
      // updated. A proper credit-note / invoice adjustment system is needed for
      // post-payment refunds to keep invoice totals correct. For now, the admin
      // must manually reconcile the invoice. See PR #655 review round 5.
      if (payment.billableToOrgInvoiceId) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { billableToOrgInvoiceId: null },
        });
      }
      refundResult = {
        refundId: `org_invoiced_refund_${crypto.randomUUID()}`,
        amount: refundAmount,
        currency: payment.currency,
        status: "SUCCEEDED" as const,
        metadata: { method: "ORG_INVOICED", unbilled: true },
      };
    } else {
      // Standard gateway refund (TAG_ONLY / B2C / CARD).
      try {
        refundResult = await createRefund({
          paymentIntentId: payment.paymentIntent,
          amount: refundAmount,
          reason,
        });
      } catch (gatewayError) {
        // Gateway call failed - mark refund as FAILED
        await prisma.refund.update({
          where: { id: pendingRefund.id },
          data: {
            status: "FAILED",
            metadata: {
              error:
                gatewayError instanceof Error
                  ? gatewayError.message
                  : "Gateway call failed",
            },
          },
        });

        throw gatewayError;
      }
    }

    // PHASE 3: Update refund record BEFORE side effects so that
    // reverseCreditsForPayment() can see this refund as SUCCEEDED when
    // computing cumulative restoration (it queries SUCCEEDED refunds).
    const finalRefund = await prisma.refund.update({
      where: { id: pendingRefund.id },
      data: {
        status: refundResult.status,
        refundId: refundResult.refundId,
        metadata: refundResult.metadata as Prisma.InputJsonValue,
      },
    });

    // PHASE 4: Run refund side effects for all paths (org + gateway).
    // These mirror the side effects in handleRefundCreated() from the
    // webhook path, ensuring financial consistency regardless of how the
    // refund was triggered.
    if (refundResult.status === "SUCCEEDED") {
      try {
        await refundEarnings(payment.id, {
          refundAmount,
          paymentAmount: payment.amount,
          forceRefund: forceRefund ?? false,
        });
      } catch (earningsError) {
        console.error("[Refund] Failed to reverse earnings:", earningsError);
      }
      try {
        await prisma.$transaction(async (tx) => {
          await reverseCreditsForPayment(
            payment.id,
            tx,
            refundAmount,
            payment.amount,
          );
        });
      } catch (creditsError) {
        console.error("[Refund] Failed to reverse referral credits:", creditsError);
      }
    }

    return NextResponse.json({
      success: true,
      refund: {
        id: finalRefund.id,
        refundId: refundResult.refundId,
        amount: refundResult.amount,
        currency: refundResult.currency,
        status: refundResult.status,
        paymentId: payment.id,
      },
      message: "Refund created successfully",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 },
      );
    }

    const classified = classifyError(error, "Failed to create refund");
    logClassifiedError("Refunds", classified, error);

    return NextResponse.json(
      { error: classified.errorMessage },
      { status: classified.httpStatus },
    );
  }
}

// ============================================================================
// GET /api/payments/refunds - List Refunds
// ============================================================================

export async function GET(req: NextRequest) {
  try {
    // Authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Admin/Staff check
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (user?.role !== "ADMIN" && user?.role !== "STAFF") {
      return NextResponse.json(
        { error: "Forbidden - Admin access required" },
        { status: 403 },
      );
    }

    // Parse query params
    const searchParams = req.nextUrl.searchParams;
    const paymentId = searchParams.get("paymentId");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (paymentId) {
      // Get payment to check gateway
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment) {
        return NextResponse.json(
          { error: "Payment not found" },
          { status: 404 },
        );
      }

      // List refunds for specific payment from gateway
      const refunds = await listRefunds(
        payment.paymentIntent,
        payment.paymentGateway,
        limit,
      );

      return NextResponse.json({
        refunds,
        paymentId,
        count: refunds.length,
      });
    } else {
      // List all refunds from database
      const refunds = await prisma.refund.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          payment: {
            include: {
              user: { select: { id: true, email: true, name: true } },
              appointment: { select: { id: true, appointmentType: true } },
            },
          },
        },
      });

      return NextResponse.json({
        refunds: refunds.map((r) => ({
          id: r.id,
          refundId: r.refundId,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          reason: r.reason,
          gateway: r.paymentGateway,
          createdAt: r.createdAt,
          payment: {
            id: r.payment.id,
            amount: r.payment.amount,
            user: r.payment.user,
            appointment: r.payment.appointment,
          },
        })),
        count: refunds.length,
      });
    }
  } catch (error) {
    console.error("Refunds listing error:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list refunds",
      },
      { status: 500 },
    );
  }
}
