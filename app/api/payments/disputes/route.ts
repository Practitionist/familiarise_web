/**
 * Disputes API
 * Handles dispute retrieval and evidence submission
 * Note: Disputes are primarily created via webhooks when payment gateways notify us
 */

import authOptions from "@/app/api/auth/[...nextauth]/options";
import { listDisputes, submitDisputeEvidence } from "@/lib/payments";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// ============================================================================
// Validation Schemas
// ============================================================================

const submitEvidenceSchema = z.object({
  disputeId: z.string().min(1, "Dispute ID is required"),
  evidence: z.object({
    customerName: z.string().optional(),
    customerEmailAddress: z.string().email().optional(),
    customerPurchaseIp: z.string().optional(),
    cancellationPolicy: z.string().optional(),
    cancellationPolicyDisclosure: z.string().optional(),
    cancellationRebuttal: z.string().optional(),
    duplicateChargeId: z.string().optional(),
    duplicateChargeExplanation: z.string().optional(),
    duplicateChargeDocumentation: z.string().optional(),
    productDescription: z.string().optional(),
    receipt: z.string().optional(),
    customerCommunication: z.string().optional(),
    uncategorizedText: z.string().optional(),
    uncategorizedFile: z.string().optional(),
  }),
});

// ============================================================================
// GET /api/payments/disputes - List Disputes
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
    const gateway = searchParams.get("gateway") as "STRIPE" | "RAZORPAY" | null;
    const limit = parseInt(searchParams.get("limit") || "10");

    if (gateway && gateway !== "STRIPE") {
      return NextResponse.json(
        {
          error:
            "Only Stripe supports direct dispute API. Razorpay disputes are webhook-only.",
        },
        { status: 400 },
      );
    }

    if (gateway === "STRIPE") {
      // Fetch from Stripe API
      const disputes = await listDisputes("STRIPE", limit);

      return NextResponse.json({
        disputes,
        gateway: "STRIPE",
        count: disputes.length,
      });
    } else {
      // List all disputes from database
      const disputes = await prisma.dispute.findMany({
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
        disputes: disputes.map((d) => ({
          id: d.id,
          disputeId: d.disputeId,
          amount: d.amount,
          currency: d.currency,
          status: d.status,
          reason: d.reason,
          gateway: d.paymentGateway,
          dueBy: d.dueBy,
          isChargeRefundable: d.isChargeRefundable,
          createdAt: d.createdAt,
          payment: {
            id: d.payment.id,
            amount: d.payment.amount,
            user: d.payment.user,
            appointment: d.payment.appointment,
          },
        })),
        count: disputes.length,
      });
    }
  } catch (error) {
    console.error("Disputes listing error:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list disputes",
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// POST /api/payments/disputes - Submit Evidence
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
    const { disputeId: dbDisputeId, evidence } =
      submitEvidenceSchema.parse(body);

    // Move ALL validation inside transaction to prevent race conditions
    // (consistent with refunds fix)
    const result = await prisma.$transaction(async (tx) => {
      // Get dispute from database INSIDE transaction
      const dispute = await tx.dispute.findUnique({
        where: { id: dbDisputeId },
        include: {
          payment: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
          },
        },
      });

      if (!dispute) {
        throw new Error("Dispute not found");
      }

      // Check if dispute can still accept evidence INSIDE transaction
      if (
        dispute.status === "WON" ||
        dispute.status === "LOST" ||
        dispute.status === "CHARGE_REFUNDED"
      ) {
        throw new Error(
          "Dispute is already resolved and cannot accept new evidence",
        );
      }

      // Check gateway support
      if (dispute.paymentGateway !== "STRIPE") {
        throw new Error(
          "Only Stripe supports direct evidence submission. For Razorpay, use the dashboard.",
        );
      }

      // Submit to Stripe
      const disputeResult = await submitDisputeEvidence(
        {
          disputeId: dispute.disputeId,
          evidence,
        },
        dispute.paymentGateway,
      );

      // Update database INSIDE transaction
      await tx.dispute.update({
        where: { disputeId: dispute.disputeId },
        data: {
          status: disputeResult.status,
          evidence: disputeResult.evidence as Prisma.InputJsonValue,
        },
      });

      return { dispute, disputeResult };
    });

    return NextResponse.json({
      success: true,
      dispute: {
        id: result.dispute.id,
        disputeId: result.disputeResult.disputeId,
        status: result.disputeResult.status,
        isChargeRefundable: result.disputeResult.isChargeRefundable,
        dueBy: result.disputeResult.dueBy,
      },
      message: "Evidence submitted successfully",
    });
  } catch (error) {
    console.error("Evidence submission error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to submit evidence",
      },
      { status: 500 },
    );
  }
}
