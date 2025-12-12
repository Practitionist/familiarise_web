/**
 * Refund Reconciliation Cron Job
 *
 * Reconciles PENDING refunds that may be stuck due to:
 * - App crash after gateway call succeeded but before DB update
 * - Network timeout during Phase 3 of two-phase refund pattern
 *
 * Schedule: Every 15 minutes via Vercel Cron or manual trigger
 *
 * Setup for Vercel Cron - add to vercel.json:
 *   crons: [{ path: "/api/cleanup/reconcile-refunds", schedule: every 15 min }]
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentGateway, Prisma, RefundStatus } from "@prisma/client";
import { listRefunds } from "@/lib/payments";

// Threshold: Only reconcile refunds older than 1 hour
const RECONCILIATION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// Time window for matching refunds (5 minutes)
const MATCHING_TIME_WINDOW_MS = 5 * 60 * 1000;

interface ReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  failedCount: number;
  skippedCount: number;
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
      console.warn("Unauthorized refund reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting refund reconciliation...");

    const result = await reconcilePendingRefunds();

    console.log("✅ Refund reconciliation completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error in refund reconciliation job:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile refunds",
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
 * Find and reconcile PENDING refunds with placeholder IDs
 */
async function reconcilePendingRefunds(): Promise<ReconciliationResult> {
  const thresholdDate = new Date(Date.now() - RECONCILIATION_THRESHOLD_MS);
  const errors: string[] = [];
  let reconciledCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  // Find PENDING refunds with placeholder refundId older than threshold
  const staleRefunds = await prisma.refund.findMany({
    where: {
      status: RefundStatus.PENDING,
      refundId: { startsWith: "pending_" },
      createdAt: { lt: thresholdDate },
    },
    include: {
      payment: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  console.log(`Found ${staleRefunds.length} stale PENDING refunds to reconcile`);

  for (const refund of staleRefunds) {
    try {
      // Skip if payment gateway is not supported for refund listing
      if (
        refund.payment.paymentGateway !== PaymentGateway.STRIPE &&
        refund.payment.paymentGateway !== PaymentGateway.RAZORPAY
      ) {
        console.log(
          `⏭️ Skipping refund ${refund.id} - unsupported gateway: ${refund.payment.paymentGateway}`,
        );
        skippedCount++;
        continue;
      }

      // Query gateway for actual refunds on this payment
      const gatewayRefunds = await listRefunds(
        refund.payment.paymentIntent,
        refund.payment.paymentGateway,
        20, // Limit to 20 refunds
      );

      // Find matching refund by amount and approximate time window
      const matchingRefund = gatewayRefunds.find((gr) => {
        const amountMatches = gr.amount === refund.amount;
        const timeMatches =
          gr.metadata?.created &&
          Math.abs(
            new Date(gr.metadata.created as string).getTime() -
              refund.createdAt.getTime(),
          ) < MATCHING_TIME_WINDOW_MS;

        return amountMatches && timeMatches;
      });

      if (matchingRefund) {
        // Update refund with real gateway data
        await prisma.refund.update({
          where: { id: refund.id },
          data: {
            refundId: matchingRefund.refundId,
            status: mapGatewayRefundStatus(matchingRefund.status),
            metadata: matchingRefund.metadata as Prisma.InputJsonValue,
          },
        });

        console.log(
          `✅ Reconciled refund ${refund.id} -> ${matchingRefund.refundId} (status: ${matchingRefund.status})`,
        );
        reconciledCount++;
      } else {
        // No matching refund found at gateway - check if refund is very old
        const refundAge = Date.now() - refund.createdAt.getTime();
        const isVeryOld = refundAge > 24 * 60 * 60 * 1000; // 24 hours

        if (isVeryOld) {
          // Mark as FAILED if no matching refund found after 24 hours
          await prisma.refund.update({
            where: { id: refund.id },
            data: {
              status: RefundStatus.FAILED,
              metadata: {
                ...(refund.metadata as object),
                reconciliation_error:
                  "No matching refund found at gateway after 24 hours",
                reconciled_at: new Date().toISOString(),
              },
            },
          });

          console.log(
            `❌ Marked refund ${refund.id} as FAILED - no matching gateway refund found`,
          );
          failedCount++;
        } else {
          // Skip for now - refund might still be processing
          console.log(
            `⏳ Skipping refund ${refund.id} - no match found but still within grace period`,
          );
          skippedCount++;
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Error reconciling refund ${refund.id}:`, errorMessage);
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: staleRefunds.length,
    reconciledCount,
    failedCount,
    skippedCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Map gateway refund status to Prisma RefundStatus
 */
function mapGatewayRefundStatus(status: string): RefundStatus {
  switch (status.toLowerCase()) {
    case "succeeded":
    case "processed":
      return RefundStatus.SUCCEEDED;
    case "failed":
      return RefundStatus.FAILED;
    case "cancelled":
    case "canceled":
      return RefundStatus.CANCELLED;
    case "pending":
    default:
      return RefundStatus.PENDING;
  }
}
