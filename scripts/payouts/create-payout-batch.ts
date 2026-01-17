#!/usr/bin/env node

/**
 * Create Payout Batch Script
 *
 * Creates weekly payout batches for eligible consultants.
 * Aggregates READY earnings into payout records for admin approval.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:create-payout-batch`
 * - GitHub Actions: `jobs/create-payout-batch.ts`
 * - API routes: Can import and call functions directly
 *
 * Schedule: Runs weekly on Mondays at 1:30 AM IST (8:00 PM UTC Sunday)
 */

import {
  EarningStatus,
  PayoutStatus,
  PayoutMethod,
} from "@prisma/client";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";

// Configuration
const MINIMUM_PAYOUT_AMOUNT = 50000; // ₹500 in paise
const AUTO_APPROVE_THRESHOLD = 500000; // ₹5000 in paise

/**
 * Result structure for batch creation
 */
export interface BatchResult {
  success: boolean;
  batchId: string;
  payoutsCreated: number;
  totalAmount: number;
  autoApproved: number;
  pendingApproval: number;
  skippedNoAccount: number;
  errors: string[];
}

/**
 * Create a payout batch for all eligible consultants
 *
 * Finds consultants with:
 * - READY earnings >= minimum payout amount
 * - Verified payout account
 *
 * Creates payout records and links earnings.
 * Auto-approves payouts under the threshold.
 *
 * @param consultantProfileIds Optional list to limit to specific consultants
 * @returns BatchResult with details
 */
export async function createPayoutBatch(
  consultantProfileIds?: string[],
): Promise<BatchResult> {
  console.log("📦 Starting payout batch creation...");

  const batchId = `batch_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const result: BatchResult = {
    success: false,
    batchId,
    payoutsCreated: 0,
    totalAmount: 0,
    autoApproved: 0,
    pendingApproval: 0,
    skippedNoAccount: 0,
    errors: [],
  };

  try {
    // Get eligible consultants with ready earnings >= minimum payout
    const eligibleConsultants = await prisma.consultantEarnings.groupBy({
      by: ["consultantProfileId"],
      where: {
        status: EarningStatus.READY,
        payoutId: null,
        ...(consultantProfileIds?.length
          ? { consultantProfileId: { in: consultantProfileIds } }
          : {}),
      },
      _sum: { consultantShare: true },
      having: {
        consultantShare: {
          _sum: { gte: MINIMUM_PAYOUT_AMOUNT },
        },
      },
    });

    console.log(`📊 Found ${eligibleConsultants.length} eligible consultants`);

    if (eligibleConsultants.length === 0) {
      console.log("✅ No consultants eligible for payout at this time");
      result.success = true;
      return result;
    }

    // Process each eligible consultant
    for (const consultant of eligibleConsultants) {
      const { consultantProfileId, _sum } = consultant;
      const amount = _sum?.consultantShare || 0;

      try {
        // Get consultant's default payout account
        const account = await prisma.payoutAccount.findFirst({
          where: {
            consultantProfileId,
            isDefault: true,
            isVerified: true,
          },
        });

        if (!account) {
          console.warn(
            `⚠️ No verified payout account for consultant ${consultantProfileId}`,
          );
          result.skippedNoAccount++;

          // Get consultant info for logging
          const profile = await prisma.consultantProfile.findUnique({
            where: { id: consultantProfileId },
            include: { user: { select: { name: true, email: true } } },
          });
          console.warn(
            `   Consultant: ${profile?.user.name || "Unknown"} (${profile?.user.email || "no email"})`,
          );
          console.warn(`   Amount pending: ₹${(amount / 100).toFixed(2)}`);
          continue;
        }

        // Determine payout method based on account type
        let method: PayoutMethod;
        switch (account.accountType) {
          case "UPI":
            method = PayoutMethod.UPI;
            break;
          case "STRIPE_CONNECT":
            method = PayoutMethod.STRIPE_TRANSFER;
            break;
          default:
            method = PayoutMethod.BANK_TRANSFER;
        }

        // Determine if auto-approve applies
        const shouldAutoApprove = amount < AUTO_APPROVE_THRESHOLD;

        // Create payout record in a transaction
        await prisma.$transaction(async (tx) => {
          const payout = await tx.payout.create({
            data: {
              consultantProfileId,
              provider: account.provider,
              amount,
              currency: "INR",
              status: shouldAutoApprove
                ? PayoutStatus.APPROVED
                : PayoutStatus.PENDING,
              method,
              batchId,
              idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
              approvedAt: shouldAutoApprove ? new Date() : undefined,
              approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
            },
          });

          // Link earnings to this payout
          await tx.consultantEarnings.updateMany({
            where: {
              consultantProfileId,
              status: EarningStatus.READY,
              payoutId: null,
            },
            data: {
              payoutId: payout.id,
            },
          });

          // Get consultant info for logging
          const profile = await tx.consultantProfile.findUnique({
            where: { id: consultantProfileId },
            include: { user: { select: { name: true } } },
          });

          console.log(
            `✅ Created payout for ${profile?.user.name || "Unknown"}: ₹${(amount / 100).toFixed(2)} [${shouldAutoApprove ? "AUTO-APPROVED" : "PENDING"}]`,
          );
        });

        result.payoutsCreated++;
        result.totalAmount += amount;
        if (shouldAutoApprove) {
          result.autoApproved++;
        } else {
          result.pendingApproval++;
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `❌ Failed to create payout for consultant ${consultantProfileId}:`,
          errorMessage,
        );
        result.errors.push(
          `Payout creation failed for ${consultantProfileId}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errors.length === 0;

    // Summary
    console.log(`\n📈 Batch Creation Summary:`);
    console.log(`   📦 Batch ID: ${batchId}`);
    console.log(`   ✅ Payouts created: ${result.payoutsCreated}`);
    console.log(`   💰 Total amount: ₹${(result.totalAmount / 100).toFixed(2)}`);
    console.log(`   🤖 Auto-approved: ${result.autoApproved}`);
    console.log(`   ⏳ Pending approval: ${result.pendingApproval}`);
    console.log(`   ⚠️ Skipped (no account): ${result.skippedNoAccount}`);

    if (result.errors.length > 0) {
      console.warn(`   ❌ Errors: ${result.errors.length}`);
      result.errors.forEach((error, index) => {
        console.warn(`      ${index + 1}. ${error}`);
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Batch creation failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Get statistics about pending payouts
 */
export async function getPayoutStats(): Promise<{
  pending: { count: number; amount: number };
  approved: { count: number; amount: number };
  processing: { count: number; amount: number };
  completed: { count: number; amount: number };
}> {
  const [pending, approved, processing, completed] = await Promise.all([
    prisma.payout.aggregate({
      where: { status: PayoutStatus.PENDING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { status: PayoutStatus.APPROVED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { status: PayoutStatus.PROCESSING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.payout.aggregate({
      where: { status: PayoutStatus.COMPLETED },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    pending: { count: pending._count, amount: pending._sum.amount || 0 },
    approved: { count: approved._count, amount: approved._sum.amount || 0 },
    processing: { count: processing._count, amount: processing._sum.amount || 0 },
    completed: { count: completed._count, amount: completed._sum.amount || 0 },
  };
}

/**
 * Run the batch creation task
 */
export async function runBatchCreationTask(): Promise<BatchResult> {
  const startTime = Date.now();
  console.log(`🚀 Starting payout batch creation at ${new Date().toISOString()}`);

  try {
    // Get pre-batch stats
    const preStats = await getPayoutStats();
    console.log(`\n📊 Pre-batch Stats:`);
    console.log(`   ⏳ Pending: ${preStats.pending.count} (₹${(preStats.pending.amount / 100).toFixed(2)})`);
    console.log(`   ✅ Approved: ${preStats.approved.count} (₹${(preStats.approved.amount / 100).toFixed(2)})`);

    // Create batch
    const result = await createPayoutBatch();

    // Get post-batch stats
    const postStats = await getPayoutStats();
    console.log(`\n📊 Post-batch Stats:`);
    console.log(`   ⏳ Pending: ${postStats.pending.count} (₹${(postStats.pending.amount / 100).toFixed(2)})`);
    console.log(`   ✅ Approved: ${postStats.approved.count} (₹${(postStats.approved.amount / 100).toFixed(2)})`);

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the batch creation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBatchCreationTask()
    .then((result) => {
      if (result.success) {
        console.log("🎉 Payout batch creation completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Payout batch creation completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Payout batch creation failed:", error);
      process.exit(1);
    });
}
