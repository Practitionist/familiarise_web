/**
 * Refunds API
 * Handles refund creation, retrieval, and listing
 */

import authOptions from "@/app/api/auth/[...nextauth]/options";
import { createRefund, listRefunds } from "@/lib/payments";
import { createRefundRecord, withPaymentTransaction } from "@/lib/payments/core/transactions";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
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

    // Get payment details
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        user: { select: { id: true, email: true, name: true } },
        appointment: true,
        refunds: true,
      },
    });

    if (!payment) {
      return NextResponse.json(
        { error: "Payment not found" },
        { status: 404 },
      );
    }

    // Check if payment can be refunded
    if (payment.paymentStatus !== "SUCCEEDED") {
      return NextResponse.json(
        { error: "Only successful payments can be refunded" },
        { status: 400 },
      );
    }

    // Check if already fully refunded
    const totalRefunded = payment.refunds
      .filter((r) => r.status === "SUCCEEDED")
      .reduce((sum, r) => sum + r.amount, 0);

    if (totalRefunded >= payment.amount) {
      return NextResponse.json(
        { error: "Payment has already been fully refunded" },
        { status: 400 },
      );
    }

    // Calculate refund amount
    const refundAmount = amount || payment.amount - totalRefunded;

    if (refundAmount > payment.amount - totalRefunded) {
      return NextResponse.json(
        { error: "Refund amount exceeds available balance" },
        { status: 400 },
      );
    }

    // Create refund with transaction safety
    const result = await withPaymentTransaction(async (tx) => {
      // Create refund via payment gateway
      const refundResult = await createRefund({
        paymentIntentId: payment.paymentIntent,
        amount: refundAmount,
        reason,
      });

      // Store refund in database
      const refundRecord = await createRefundRecord(tx, {
        amount: refundAmount,
        currency: payment.currency,
        reason,
        status: refundResult.status,
        refundId: refundResult.refundId,
        paymentGateway: payment.paymentGateway,
        metadata: refundResult.metadata as Prisma.InputJsonValue,
        payment: {
          connect: { id: payment.id },
        },
      });

      return { refundResult, refundRecord };
    });

    return NextResponse.json({
      success: true,
      refund: {
        id: result.refundRecord.id,
        refundId: result.refundResult.refundId,
        amount: result.refundResult.amount,
        currency: result.refundResult.currency,
        status: result.refundResult.status,
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
          error instanceof Error
            ? error.message
            : "Failed to create refund",
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
