/**
 * Dispute Reconciliation Cron Job
 *
 * Reconciles dispute status with payment gateways to ensure data consistency.
 * Handles cases where:
 * - DB update failed after Stripe API call succeeded
 * - Webhooks were missed or delayed
 * - Dispute status changed but webhook wasn't received
 *
 * Schedule: Every 6 hours via Vercel Cron or manual trigger
 *
 * Setup for Vercel Cron - add to vercel.json:
 *   crons: [{ path: "/api/cleanup/reconcile-disputes", schedule: every 6 hours }]
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DisputeStatus, PaymentGateway, Prisma } from "@prisma/client";
import { getDispute } from "@/lib/payments";

// Prioritize disputes with approaching deadlines (7 days)
const APPROACHING_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

// Flag disputes not updated in 24 hours as potentially stale
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface ReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  urgentCount: number;
  razorpayManualReviewCount: number;
  errors: string[];
  timestamp: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized dispute reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting dispute reconciliation...");

    const result = await reconcileDisputes();

    console.log("✅ Dispute reconciliation completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      urgentCount: result.urgentCount,
      razorpayManualReviewCount: result.razorpayManualReviewCount,
    });

    // Alert on urgent disputes
    if (result.urgentCount > 0) {
      console.warn(
        `⚠️ ALERT: ${result.urgentCount} disputes require immediate attention (deadline within 48 hours)!`,
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error in dispute reconciliation job:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile disputes",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Also support POST for manual triggering
export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}

/**
 * Find and reconcile disputes that may have stale status
 */
async function reconcileDisputes(): Promise<ReconciliationResult> {
  const approachingDeadline = new Date(Date.now() + APPROACHING_DEADLINE_MS);
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const urgentThreshold = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

  const errors: string[] = [];
  let reconciledCount = 0;
  let urgentCount = 0;
  let razorpayManualReviewCount = 0;

  // Find disputes needing reconciliation:
  // 1. Status is active (needs response or under review)
  // 2. Either approaching deadline OR stale (not updated recently)
  const disputesToReconcile = await prisma.dispute.findMany({
    where: {
      status: {
        in: [
          DisputeStatus.NEEDS_RESPONSE,
          DisputeStatus.WARNING_NEEDS_RESPONSE,
          DisputeStatus.UNDER_REVIEW,
          DisputeStatus.WARNING_UNDER_REVIEW,
        ],
      },
      OR: [
        { dueBy: { lte: approachingDeadline } },
        { updatedAt: { lt: staleThreshold } },
      ],
    },
    include: {
      payment: true,
    },
    orderBy: {
      dueBy: "asc", // Prioritize those with earliest deadlines
    },
  });

  console.log(`Found ${disputesToReconcile.length} disputes to reconcile`);

  for (const dispute of disputesToReconcile) {
    try {
      // Check if dispute is urgent (deadline within 48 hours)
      if (dispute.dueBy && dispute.dueBy.getTime() < urgentThreshold.getTime()) {
        urgentCount++;
        console.warn(
          `⚠️ URGENT: Dispute ${dispute.disputeId} due by ${dispute.dueBy.toISOString()}`,
        );
      }

      // Razorpay doesn't support dispute API - log for manual review
      if (dispute.paymentGateway === PaymentGateway.RAZORPAY) {
        razorpayManualReviewCount++;
        console.log(
          `📋 Razorpay dispute ${dispute.disputeId} requires manual dashboard review`,
        );
        continue;
      }

      // Skip non-Stripe gateways
      if (dispute.paymentGateway !== PaymentGateway.STRIPE) {
        console.log(
          `⏭️ Skipping dispute ${dispute.disputeId} - unsupported gateway: ${dispute.paymentGateway}`,
        );
        continue;
      }

      // Query Stripe for current dispute status
      const gatewayDispute = await getDispute(
        dispute.disputeId,
        PaymentGateway.STRIPE,
      );

      // Check if status has changed
      const newStatus = mapGatewayDisputeStatus(gatewayDispute.status);
      if (newStatus !== dispute.status) {
        await prisma.dispute.update({
          where: { disputeId: dispute.disputeId },
          data: {
            status: newStatus,
            evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
            isChargeRefundable: gatewayDispute.isChargeRefundable,
            dueBy: gatewayDispute.dueBy,
          },
        });

        console.log(
          `✅ Reconciled dispute ${dispute.disputeId}: ${dispute.status} -> ${newStatus}`,
        );
        reconciledCount++;
      } else {
        // Update dueBy and evidence even if status unchanged
        await prisma.dispute.update({
          where: { disputeId: dispute.disputeId },
          data: {
            dueBy: gatewayDispute.dueBy,
            evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
            isChargeRefundable: gatewayDispute.isChargeRefundable,
          },
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Handle "dispute not found" case - may have been resolved
      if (errorMessage.includes("resource_missing") || errorMessage.includes("not found")) {
        const existingEvidence = (dispute.evidence ?? {}) as Record<string, unknown>;
        await prisma.dispute.update({
          where: { disputeId: dispute.disputeId },
          data: {
            status: DisputeStatus.WON,
            evidence: {
              ...existingEvidence,
              reconciliation_note:
                "Dispute no longer exists at gateway - marked as WON",
              reconciled_at: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        console.log(
          `✅ Dispute ${dispute.disputeId} no longer exists at gateway - marked as WON`,
        );
        reconciledCount++;
      } else {
        errors.push(`Dispute ${dispute.disputeId}: ${errorMessage}`);
        console.error(
          `Error reconciling dispute ${dispute.disputeId}:`,
          errorMessage,
        );
      }
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: disputesToReconcile.length,
    reconciledCount,
    urgentCount,
    razorpayManualReviewCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Map gateway dispute status string to Prisma DisputeStatus
 */
function mapGatewayDisputeStatus(status: string): DisputeStatus {
  switch (status.toLowerCase()) {
    case "warning_needs_response":
      return DisputeStatus.WARNING_NEEDS_RESPONSE;
    case "warning_under_review":
      return DisputeStatus.WARNING_UNDER_REVIEW;
    case "warning_closed":
      return DisputeStatus.WARNING_CLOSED;
    case "needs_response":
      return DisputeStatus.NEEDS_RESPONSE;
    case "under_review":
      return DisputeStatus.UNDER_REVIEW;
    case "charge_refunded":
      return DisputeStatus.CHARGE_REFUNDED;
    case "won":
      return DisputeStatus.WON;
    case "lost":
      return DisputeStatus.LOST;
    default:
      console.warn(`Unknown dispute status: ${status}, defaulting to NEEDS_RESPONSE`);
      return DisputeStatus.NEEDS_RESPONSE;
  }
}
