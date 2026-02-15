/**
 * Refund-Earning Cascade - Core Logic
 *
 * Cascades refund status updates to ConsultantEarnings.
 * When a refund succeeds, the associated consultant earnings must be marked as REFUNDED
 * to prevent incorrect payouts.
 *
 * This module exports the core cascade function.
 * It is imported by:
 * - jobs/cascade-refund-earnings.ts (GitHub Actions)
 * - app/api/jobs/cascade-refund-earnings/route.ts (API endpoint)
 *
 * GitHub Issue: #305
 * Schedule: Every 15 minutes
 */

import prisma from "../../lib/prisma";
import { EarningStatus, RefundStatus } from "@prisma/client";

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
 * Find succeeded refunds with non-REFUNDED earnings and update them
 */
export async function cascadeRefundToEarnings(): Promise<RefundEarningCascadeResult> {
  const errors: string[] = [];
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Find all succeeded refunds where associated earnings haven't been updated
  // This catches cases where:
  // 1. Refund succeeded but app crashed before updating earnings
  // 2. Webhook was missed or delayed
  // 3. Manual refund was processed at gateway
  const refundsToProcess = await prisma.refund.findMany({
    where: {
      status: RefundStatus.SUCCEEDED,
      payment: {
        earnings: {
          some: {
            status: {
              in: [
                EarningStatus.PENDING,
                EarningStatus.HELD,
                EarningStatus.READY,
              ],
            },
          },
        },
      },
    },
    include: {
      payment: {
        include: {
          earnings: true,
        },
      },
    },
  });

  console.log(
    `Found ${refundsToProcess.length} succeeded refunds with non-REFUNDED earnings`,
  );

  for (const refund of refundsToProcess) {
    const earningsList = refund.payment.earnings;

    if (!earningsList || earningsList.length === 0) {
      console.log(
        `⏭️ Skipping refund ${refund.id} - no associated earnings record`,
      );
      skippedCount++;
      continue;
    }

    for (const earnings of earningsList) {
      try {
        // Update earnings status to REFUNDED
        await prisma.consultantEarnings.update({
          where: { id: earnings.id },
          data: {
            status: EarningStatus.REFUNDED,
          },
        });

        console.log(
          `✅ Updated earnings ${earnings.id} to REFUNDED (refund: ${refund.id})`,
        );
        updatedCount++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push(`Earnings ${earnings.id}: ${errorMessage}`);
        console.error(`❌ Error updating earnings ${earnings.id}:`, errorMessage);
        errorCount++;
      }
    }
  }

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
