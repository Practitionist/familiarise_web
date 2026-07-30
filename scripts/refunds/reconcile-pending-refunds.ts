/**
 * Refund Reconciliation - Core Logic
 *
 * Reconciles PENDING refunds that may be stuck due to:
 * - App crash after gateway call succeeded but before DB update
 * - Network timeout during Phase 3 of two-phase refund pattern
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-pending-refunds.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-refunds/route.ts (API endpoint)
 */

import prisma from "../../lib/prisma";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import { PaymentGateway, Prisma, RefundStatus } from "@prisma/client";
import { listRefunds } from "../../lib/payments";
import { notifyRefundFailed } from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { getAppUrl } from "../../lib/url";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

// Threshold: Only reconcile refunds older than 1 hour
const RECONCILIATION_THRESHOLD_MS = 60 * 60 * 1000;

// Time window for matching refunds (5 minutes)
const MATCHING_TIME_WINDOW_MS = 5 * 60 * 1000;

export interface RefundReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  failedCount: number;
  skippedCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Map gateway refund status to Prisma RefundStatus
 */

/**
 * Find and reconcile PENDING refunds with placeholder IDs
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcilePendingRefunds(): Promise<RefundReconciliationResult> {
  return withCronLock(
    "reconcile-pending-refunds",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcilePendingRefundsUnlocked(),
  );
}

async function reconcilePendingRefundsUnlocked(): Promise<RefundReconciliationResult> {
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

  console.log(
    `Found ${staleRefunds.length} stale PENDING refunds to reconcile`,
  );

  for (const refund of staleRefunds) {
    try {
      // Skip if payment gateway is not supported
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
        20,
      );

      // Find matching refund by amount and approximate time window
      const matchingRefund = gatewayRefunds.find((gr) => {
        const amountMatches = gr.amount === refund.amountPaise;
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
        // No matching refund found - check if very old
        const refundAge = Date.now() - refund.createdAt.getTime();
        const isVeryOld = refundAge > 24 * 60 * 60 * 1000; // 24 hours

        if (isVeryOld) {
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

// #779 §A — default failure reason when the gateway metadata carries none.
const REFUND_FAILED_DEFAULT_REASON = "Gateway rejected the refund";

export interface FailedRefundNotifyResult {
  scanned: number;
  notified: number;
}

/**
 * #779 §A — notify the payer when a refund FAILED. The two-phase refund +
 * reconcile path can leave a Refund in FAILED without the payer ever hearing.
 * Selects FAILED refunds where `failedNotifiedAt` is null, backfills
 * `failureReason` / `failedAt` if empty (from gateway metadata if present,
 * else the default copy), notifies the payer, and claim-stamps
 * `failedNotifiedAt` so the same failure isn't paged twice.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function notifyFailedRefunds(): Promise<FailedRefundNotifyResult> {
  return withCronLock(
    "reconcile-pending-refunds",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => notifyFailedRefundsUnlocked(),
  );
}

async function notifyFailedRefundsUnlocked(): Promise<FailedRefundNotifyResult> {
  const now = new Date();
  const failed = await prisma.refund.findMany({
    where: {
      status: RefundStatus.FAILED,
      failedNotifiedAt: null,
    },
    include: { payment: { select: { userId: true, organizationId: true } } },
    orderBy: { createdAt: "asc" },
  });

  let notified = 0;
  for (const refund of failed) {
    // Prefer a gateway-supplied reason carried in metadata; fall back to the
    // existing operator `reason` only as failure context, else default copy.
    const meta = (refund.metadata ?? {}) as Record<string, unknown>;
    const gatewayReason =
      typeof meta.failure_reason === "string"
        ? meta.failure_reason
        : typeof meta.error_description === "string"
          ? meta.error_description
          : null;
    const failureReason =
      refund.failureReason ?? gatewayReason ?? REFUND_FAILED_DEFAULT_REASON;

    // Claim the row: stamp failedNotifiedAt only if still null so a re-run or
    // a second replica can't double-notify. Backfill failureReason / failedAt
    // in the same gate when they're empty.
    const claim = await prisma.refund.updateMany({
      where: { id: refund.id, failedNotifiedAt: null },
      data: {
        failedNotifiedAt: now,
        failureReason: refund.failureReason ?? failureReason,
        failedAt: refund.failedAt ?? now,
      },
    });
    if (claim.count === 0) continue;
    notified++;

    // Fire-and-forget — committed state, no DB writes in the notify path.
    void notifyRefundFailed(refund.payment.userId, {
      ...notificationScope(refund.payment.organizationId),
      amount: refund.amountPaise,
      currency: refund.currency,
      reason: failureReason,
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
  }

  return { scanned: failed.length, notified };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
