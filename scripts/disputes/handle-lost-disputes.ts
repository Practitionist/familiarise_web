/**
 * Lost Dispute Handler - Core Logic
 *
 * Handles lost Stripe disputes by cascading impact to consultant earnings.
 * When a dispute is lost, the consultant's earnings must be marked as REFUNDED
 * to prevent incorrect payouts.
 *
 * This catches cases where:
 * - Dispute webhook was missed or delayed
 * - DB update failed after Stripe API call
 * - Manual dispute resolution at gateway
 *
 * This module exports the core handler function.
 * It is imported by:
 * - jobs/handle-lost-disputes.ts (GitHub Actions)
 * - app/api/cleanup/handle-lost-disputes/route.ts (API endpoint)
 *
 * GitHub Issue: #304
 * Schedule: Every 6 hours
 */

import prisma from "../../lib/prisma";
import { DisputeStatus, EarningStatus } from "@prisma/client";

export interface LostDisputeHandlerResult {
  success: boolean;
  totalProcessed: number;
  updatedCount: number;
  skippedCount: number;
  alreadyPaidCount: number;
  errorCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Find lost disputes with non-REFUNDED earnings and update them
 */
export async function handleLostDisputes(): Promise<LostDisputeHandlerResult> {
  const errors: string[] = [];
  let updatedCount = 0;
  let skippedCount = 0;
  let alreadyPaidCount = 0;
  let errorCount = 0;

  // Find all LOST disputes where associated earnings haven't been updated
  const lostDisputes = await prisma.dispute.findMany({
    where: {
      status: DisputeStatus.LOST,
      payment: {
        earnings: {
          some: {
            status: {
              notIn: [EarningStatus.REFUNDED], // Not already refunded
            },
          },
        },
      },
    },
    include: {
      payment: {
        include: {
          earnings: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { name: true, email: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  console.log(
    `Found ${lostDisputes.length} lost disputes with non-REFUNDED earnings`,
  );

  for (const dispute of lostDisputes) {
    const earningsList = dispute.payment.earnings;

    if (!earningsList || earningsList.length === 0) {
      console.log(
        `⏭️ Skipping dispute ${dispute.disputeId} - no associated earnings record`,
      );
      skippedCount++;
      continue;
    }

    for (const earnings of earningsList) {
    // Check if earnings were already paid out
    if (earnings.status === EarningStatus.PAID) {
      // This is a critical situation - earnings were paid but dispute was lost
      console.error(
        `⚠️ CRITICAL: Dispute ${dispute.disputeId} lost but earnings ${earnings.id} already PAID!`,
      );
      console.error(
        `   Consultant: ${earnings.consultantProfile.user.name || "Unknown"} (${earnings.consultantProfile.user.email})`,
      );
      console.error(
        `   Amount: ₹${(earnings.consultantShare / 100).toFixed(2)}`,
      );
      console.error(`   Manual recovery required!`);

      // Still mark as REFUNDED to prevent double-payout, but flag for manual review
      try {
        await prisma.consultantEarnings.update({
          where: { id: earnings.id },
          data: {
            status: EarningStatus.REFUNDED,
          },
        });

        alreadyPaidCount++;
        updatedCount++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push(`Earnings ${earnings.id} (PAID): ${errorMessage}`);
        errorCount++;
      }
      continue;
    }

    try {
      // Update earnings status to REFUNDED
      await prisma.consultantEarnings.update({
        where: { id: earnings.id },
        data: {
          status: EarningStatus.REFUNDED,
        },
      });

      // Decrease consultant's pending revenue
      await prisma.consultantProfile.update({
        where: { id: earnings.consultantProfileId },
        data: {
          pendingRevenue: { decrement: earnings.consultantShare },
        },
      });

      console.log(
        `✅ Updated earnings ${earnings.id} to REFUNDED (dispute: ${dispute.disputeId}, amount: ₹${(earnings.consultantShare / 100).toFixed(2)})`,
      );
      updatedCount++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Earnings ${earnings.id}: ${errorMessage}`);
      console.error(`❌ Error updating earnings ${earnings.id}:`, errorMessage);
      errorCount++;
    }
    } // end for earnings
  }

  // Log summary of critical cases
  if (alreadyPaidCount > 0) {
    console.log(
      `\n⚠️ ATTENTION: ${alreadyPaidCount} earnings were already PAID when dispute was lost - manual recovery required!`,
    );
  }

  return {
    success: errors.length === 0,
    totalProcessed: lostDisputes.length,
    updatedCount,
    skippedCount,
    alreadyPaidCount,
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
