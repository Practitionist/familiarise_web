#!/usr/bin/env node

/**
 * Release Earnings Script
 *
 * Releases consultant earnings from hold period to READY status.
 * Earnings are held for a period after payment to handle refunds/disputes.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:release-earnings`
 * - GitHub Actions: `jobs/release-earnings.ts`
 * - API routes: Can import and call functions directly
 *
 * Schedule: Runs hourly via GitHub Actions
 */

import { EarningStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

/**
 * Result structure for release operations
 */
export interface ReleaseResult {
  success: boolean;
  releasedCount: number;
  errorCount: number;
  errors: string[];
}

/**
 * Release earnings that have passed their hold period
 *
 * Finds earnings with:
 * - Status: PENDING
 * - holdUntil: Past current time
 *
 * Updates them to READY status for payout processing.
 *
 * @returns ReleaseResult with counts and error details
 */
export async function releaseEarningsFromHold(): Promise<ReleaseResult> {
  console.log("💰 Starting earnings release from hold...");

  const result: ReleaseResult = {
    success: false,
    releasedCount: 0,
    errorCount: 0,
    errors: [],
  };

  try {
    const now = new Date();

    // #776 — read the snapshot and claim the rows inside one Serializable tx so an
    // overlapping cron run can't observe the same PENDING set and double-count the
    // release in logs/metrics. The updateMany predicate is the real money guard
    // (already-READY rows are skipped); the transaction keeps the logged snapshot
    // equal to what was actually transitioned. A serialization conflict aborts this
    // run; the next hourly run reaps the rows.
    const { earningsToRelease, releasedCount } = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.consultantEarnings.findMany({
          where: {
            status: EarningStatus.PENDING,
            holdUntil: { lte: now },
          },
          include: {
            consultantProfile: {
              include: {
                user: { select: { name: true, email: true } },
              },
            },
            payment: { select: { id: true, amount: true } },
          },
        });

        const updated = await tx.consultantEarnings.updateMany({
          where: {
            status: EarningStatus.PENDING,
            holdUntil: { lte: now },
          },
          data: {
            status: EarningStatus.READY,
          },
        });

        return { earningsToRelease: rows, releasedCount: updated.count };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    console.log(
      `📊 Found ${earningsToRelease.length} earnings ready for release`,
    );

    if (earningsToRelease.length === 0) {
      console.log("✅ No earnings to release at this time");
      result.success = true;
      return result;
    }

    result.releasedCount = releasedCount;

    // Log details for each released earning
    for (const earning of earningsToRelease) {
      console.log(
        `✅ Released earning ${earning.id}: ₹${(earning.consultantSharePaise / 100).toFixed(2)} for ${earning.consultantProfile.user.name || "Unknown"}`,
      );
    }

    result.success = true;

    // Summary
    console.log(`\n📈 Release Summary:`);
    console.log(`   ✅ Released: ${result.releasedCount} earnings`);
    console.log(
      `   💰 Total amount: ₹${(earningsToRelease.reduce((sum, e) => sum + e.consultantSharePaise, 0) / 100).toFixed(2)}`,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Release job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
    result.errorCount++;
  }

  return result;
}

/**
 * Get statistics about pending earnings
 */
export async function getPendingEarningsStats(): Promise<{
  pendingCount: number;
  pendingAmount: number;
  readyCount: number;
  readyAmount: number;
}> {
  const [pending, ready] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PENDING },
      _sum: { consultantSharePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.READY },
      _sum: { consultantSharePaise: true },
      _count: true,
    }),
  ]);

  return {
    pendingCount: pending._count,
    pendingAmount: sumPaise(pending._sum.consultantSharePaise),
    readyCount: ready._count,
    readyAmount: sumPaise(ready._sum.consultantSharePaise),
  };
}

/**
 * Run the release task and print stats
 */
export async function runReleaseTask(): Promise<ReleaseResult> {
  const startTime = Date.now();
  console.log(
    `🚀 Starting earnings release job at ${new Date().toISOString()}`,
  );

  try {
    // Get pre-release stats
    const preStats = await getPendingEarningsStats();
    console.log(`\n📊 Pre-release Stats:`);
    console.log(
      `   ⏳ Pending: ${preStats.pendingCount} earnings (₹${(preStats.pendingAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Ready: ${preStats.readyCount} earnings (₹${(preStats.readyAmount / 100).toFixed(2)})`,
    );

    // Run release
    const result = await releaseEarningsFromHold();

    // Get post-release stats
    const postStats = await getPendingEarningsStats();
    console.log(`\n📊 Post-release Stats:`);
    console.log(
      `   ⏳ Pending: ${postStats.pendingCount} earnings (₹${(postStats.pendingAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Ready: ${postStats.readyCount} earnings (₹${(postStats.readyAmount / 100).toFixed(2)})`,
    );

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

// Run the release if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseTask()
    .then((result) => {
      if (result.success) {
        console.log("🎉 Earnings release job completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Earnings release job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Earnings release job failed:", error);
      process.exit(1);
    });
}
