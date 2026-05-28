/**
 * Refund-Earning Cascade — Cron Entry Point
 *
 * Picks up SUCCEEDED gateway-initiated `Refund` rows whose downstream
 * earnings (ConsultantEarnings + OrganizationEarnings) have NOT yet
 * been reversed and runs the canonical cascade.
 *
 * History: this script used to inline the ConsultantEarnings update
 * (only flipped status to REFUNDED, ignored OrganizationEarnings, the
 * wallet, BookingUtilization, and OrganizationPayout clawback). Since
 * C1 it delegates to `applyRefundCascade` in
 * `lib/payments/operations/refund.ts` so app-initiated and
 * gateway-initiated refunds share one code path.
 *
 * Two consumers:
 *   - `jobs/refunds/cascade-refund-earnings.ts` (GitHub Actions schedule)
 *   - `app/api/cleanup/cascade-refund-earnings/route.ts` (HTTP trigger)
 *
 * GitHub Issue: #305
 * Schedule: Every 15 minutes
 */

import { EarningStatus, Prisma, RefundStatus } from "@prisma/client";

import prisma from "../../lib/prisma";
import { applyRefundCascade } from "../../lib/payments/operations/refund";

export interface RefundEarningCascadeResult {
  success: boolean;
  totalProcessed: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Find SUCCEEDED refunds whose downstream earnings are still in a
 * non-REFUNDED state and run the canonical cascade against each.
 *
 * Filter rationale: we trigger when at least one ConsultantEarnings
 * row on the payment has `refundedShareAmount = 0` AND a non-terminal
 * status. The canonical cascade always increments
 * `refundedShareAmount`, so this filter is a safe "not yet cascaded"
 * signal. Earnings created before C1 may carry a non-zero
 * `refundedShareAmount` AND a non-REFUNDED status (legacy partial
 * refund); we deliberately skip those rather than double-count.
 */
export async function cascadeRefundToEarnings(): Promise<RefundEarningCascadeResult> {
  const errors: string[] = [];
  let updatedCount = 0;
  let errorCount = 0;

  const refundsToProcess = await prisma.refund.findMany({
    where: {
      status: RefundStatus.SUCCEEDED,
      payment: {
        earnings: {
          some: {
            refundedShareAmount: 0,
            status: {
              in: [
                EarningStatus.PENDING,
                EarningStatus.HELD,
                EarningStatus.READY,
                EarningStatus.PENDING_TRUST,
              ],
            },
          },
        },
      },
    },
    select: {
      id: true,
      amountPaise: true,
      reason: true,
      paymentId: true,
    },
  });

  console.log(
    `Found ${refundsToProcess.length} succeeded refunds with un-cascaded earnings`,
  );

  for (const refund of refundsToProcess) {
    try {
      await prisma.$transaction(
        async (tx) => {
          await applyRefundCascade(tx, {
            paymentId: refund.paymentId,
            refundId: refund.id,
            amountPaise: refund.amountPaise,
            reason: refund.reason ?? "Gateway refund cascade",
            initiatedByUserId: null, // gateway-initiated
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      console.log(`Cascade applied for refund ${refund.id}`);
      updatedCount++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Cascade failed for refund ${refund.id}:`, errorMessage);
      errorCount++;
    }
  }

  const skippedCount = refundsToProcess.length - updatedCount - errorCount;

  return {
    success: errors.length === 0,
    totalProcessed: refundsToProcess.length,
    updatedCount,
    skippedCount,
    errorCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
