/**
 * Approval Payment Expiration Cron Job
 *
 * Expires pending approval payments after 48 hours and reverts
 * consultation/subscription status back to PENDING.
 *
 * Schedule: Should be run every hour via cron or serverless scheduled function
 * Example: Vercel Cron, AWS EventBridge, or manual cron job
 *
 * Setup for Vercel Cron:
 * Add to vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/cleanup/approval-payments",
 *     "schedule": "0 * * * *"  // Every hour
 *   }]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentStatus, Prisma, RequestStatus } from "@prisma/client";

/**
 * Revert consultation or subscription status from APPROVED_PENDING_PAYMENT to PENDING
 * Used when payment link expires after 48 hours
 *
 * FIX: Re-checks status inside transaction to prevent race condition where
 * user completes payment between initial query and transaction execution.
 */
async function revertApprovalStatus(
  tx: Prisma.TransactionClient,
  entityType: "consultation" | "subscription",
  entityId: string,
): Promise<boolean> {
  const systemNote =
    "[System] Payment expired after 48 hours. Status reverted to PENDING.";

  if (entityType === "consultation") {
    // Re-fetch inside transaction to get current status (prevents race condition)
    const consultation = await tx.consultation.findUnique({
      where: { id: entityId },
      select: { requestStatus: true, requestNotes: true },
    });

    // Check status INSIDE transaction - if user completed payment, status will be APPROVED
    if (
      !consultation ||
      consultation.requestStatus !== RequestStatus.APPROVED_PENDING_PAYMENT
    ) {
      console.log(
        `⏭️ Skipping consultation ${entityId} - status is ${consultation?.requestStatus || "not found"}`,
      );
      return false; // Already processed or status changed
    }

    await tx.consultation.update({
      where: { id: entityId },
      data: {
        requestStatus: RequestStatus.PENDING,
        requestNotes: consultation.requestNotes
          ? `${consultation.requestNotes}\n\n${systemNote}`
          : systemNote,
      },
    });

    console.log(`✅ Reverted consultation ${entityId} to PENDING`);
    return true;
  } else {
    // Re-fetch inside transaction to get current status (prevents race condition)
    const subscription = await tx.subscription.findUnique({
      where: { id: entityId },
      select: { requestStatus: true, requestNotes: true },
    });

    // Check status INSIDE transaction - if user completed payment, status will be APPROVED
    if (
      !subscription ||
      subscription.requestStatus !== RequestStatus.APPROVED_PENDING_PAYMENT
    ) {
      console.log(
        `⏭️ Skipping subscription ${entityId} - status is ${subscription?.requestStatus || "not found"}`,
      );
      return false; // Already processed or status changed
    }

    await tx.subscription.update({
      where: { id: entityId },
      data: {
        requestStatus: RequestStatus.PENDING,
        requestNotes: subscription.requestNotes
          ? `${subscription.requestNotes}\n\n${systemNote}`
          : systemNote,
      },
    });

    console.log(`✅ Reverted subscription ${entityId} to PENDING`);
    return true;
  }
}

export async function GET(req: NextRequest) {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized cron job attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🕐 Starting approval payment expiration check...");

    // Find expired pending payments
    // Note: Only checking expiresAt is sufficient since expiresAt = createdAt + 48 hours
    const expiredPayments = await prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.PENDING,
        expiresAt: {
          not: null,
          lt: new Date(),
        },
      },
      include: {
        appointment: {
          include: {
            consultation: true,
            subscription: true,
          },
        },
      },
    });

    console.log(`Found ${expiredPayments.length} expired pending payments`);

    let consultationsReverted = 0;
    let subscriptionsReverted = 0;
    let paymentsExpired = 0;

    for (const payment of expiredPayments) {
      try {
        await prisma.$transaction(async (tx) => {
          // Revert consultation status (status re-checked inside function)
          if (payment.appointment?.consultation) {
            const reverted = await revertApprovalStatus(
              tx,
              "consultation",
              payment.appointment.consultation.id,
            );
            if (reverted) consultationsReverted++;
          }

          // Revert subscription status (status re-checked inside function)
          if (payment.appointment?.subscription) {
            const reverted = await revertApprovalStatus(
              tx,
              "subscription",
              payment.appointment.subscription.id,
            );
            if (reverted) subscriptionsReverted++;
          }

          // Mark payment as FAILED (expired)
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              paymentStatus: PaymentStatus.FAILED,
              description: payment.description
                ? `${payment.description} - Expired after 48 hours`
                : "Payment expired after 48 hours",
            },
          });

          paymentsExpired++;
        });
      } catch (error) {
        console.error(`Error processing payment ${payment.id}:`, error);
        // Continue with next payment
      }
    }

    const result = {
      success: true,
      message: "Approval payment expiration check completed",
      statistics: {
        totalExpiredPayments: expiredPayments.length,
        paymentsExpired,
        consultationsReverted,
        subscriptionsReverted,
      },
      timestamp: new Date().toISOString(),
    };

    console.log(
      "✅ Approval payment expiration check completed:",
      result.statistics,
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error in approval payment expiration job:", error);
    return NextResponse.json(
      {
        error: "Failed to process payment expirations",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Also support POST for manual triggering
export async function POST(req: NextRequest) {
  return GET(req);
}
