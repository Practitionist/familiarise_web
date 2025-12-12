/**
 * Refunds API
 * Handles refund creation, retrieval, and listing
 */

import authOptions from "@/app/api/auth/[...nextauth]/options";
import { createRefund, listRefunds } from "@/lib/payments";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// ============================================================================
// Validation Schemas
// ============================================================================

const createRefundSchema = z.object({
  paymentId: z.string().min(1, "Payment ID is required"),
  amount: z.number().positive().optional(),
  reason: z.string().optional(),
});

const getRefundsSchema = z.object({
  paymentId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

// ============================================================================
// POST /api/payments/refunds - Create Refund
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    // Authentication
    const session = await getServerSession(authOptions);
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
    const { paymentId, amount, reason } = createRefundSchema.parse(body);

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
      // Get payment with refunds inside transaction
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          user: { select: { id: true, email: true, name: true } },
          appointment: true,
          refunds: true,
        },
      });

      if (!payment) {
        throw new Error("Payment not found");
      }

      if (payment.paymentStatus !== "SUCCEEDED") {
        throw new Error("Only successful payments can be refunded");
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
          metadata: {},
          paymentId: payment.id,
        },
      });

      return { payment, pendingRefund, refundAmount };
    });

    const { payment, pendingRefund, refundAmount } = phase1Result;

    // PHASE 2: Call external payment gateway OUTSIDE transaction
    let refundResult;
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

    // PHASE 3: Update refund record with gateway result
    const finalRefund = await prisma.refund.update({
      where: { id: pendingRefund.id },
      data: {
        status: refundResult.status,
        refundId: refundResult.refundId,
        metadata: refundResult.metadata as Prisma.InputJsonValue,
      },
    });

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
    console.error("Refund creation error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create refund",
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// GET /api/payments/refunds - List Refunds
// ============================================================================

export async function GET(req: NextRequest) {
  try {
    // Authentication
    const session = await getServerSession(authOptions);
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
