/**
 * Create Payout Batch Job (GitHub Actions Version)
 *
 * Thin wrapper around the core batch creation logic in scripts/create-payout-batch.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * TODO #620: Migrate to canonical lib/payments/payouts service once return type
 * compatibility is addressed (canonical returns string batchId vs BatchResult).
 *
 * Runs weekly on Mondays at 8:00 PM UTC (1:30 AM IST next day).
 */

import {
  createPayoutBatch,
  disconnectDatabase,
  type BatchResult,
} from "../../scripts/payouts/create-payout-batch";

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";

/**
 * Output results to GitHub Actions using environment files
 */
function outputToGitHubActions(result: BatchResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `batch_id=${result.batchId}`,
      `payouts_created=${result.payoutsCreated}`,
      `total_amount=${result.totalAmount}`,
      `auto_approved=${result.autoApproved}`,
      `pending_approval=${result.pendingApproval}`,
      `skipped_no_account=${result.skippedNoAccount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    const allErrors = result.errors.join("; ");
    console.log(
      `::error::Create payout batch job completed with errors: ${allErrors}`,
    );
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("create-payout-batch");
  Sentry.logger.info("job:create-payout-batch started");
  const startTime = Date.now();
  console.log(
    `🚀 Starting payout batch creation job at ${new Date().toISOString()}`,
  );

  try {
    // Run batch creation
    const result = await createPayoutBatch();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Summary
    console.log(`\n📊 Batch Creation Summary:`);
    console.log(`   📦 Batch ID: ${result.batchId}`);
    console.log(`   ✅ Payouts created: ${result.payoutsCreated}`);
    console.log(
      `   💰 Total amount: ₹${(result.totalAmount / 100).toFixed(2)}`,
    );
    console.log(`   🤖 Auto-approved: ${result.autoApproved}`);
    console.log(`   ⏳ Pending approval: ${result.pendingApproval}`);
    console.log(`   ⚠️ Skipped (no account): ${result.skippedNoAccount}`);

    // Output to GitHub Actions
    outputToGitHubActions(result);

    if (result.success) {
      Sentry.logger.info("job:create-payout-batch finished", {
        payoutsCreated: result.payoutsCreated,
        totalAmount: result.totalAmount,
        autoApproved: result.autoApproved,
        pendingApproval: result.pendingApproval,
        skippedNoAccount: result.skippedNoAccount,
      });
      console.log("🎉 Payout batch creation job completed successfully");
      process.exit(0);
    } else {
      console.error("❌ Payout batch creation job completed with errors");
      process.exit(1);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    Sentry.captureException(error, { tags: { subsystem: "jobs", job: "create-payout-batch" } });
    console.error("💥 Payout batch creation job failed:", errorMessage);

    if (process.env.GITHUB_ACTIONS) {
      const outputFile = process.env.GITHUB_OUTPUT;
      if (outputFile) {
        fs.appendFileSync(outputFile, "success=false\n");
      }
      console.log(`::error::Payout batch creation job failed: ${errorMessage}`);
    }

    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Run the job
main().catch((error) => {
  console.error("\n❌ Payout batch creation job failed:");
  console.error(error);
  process.exit(1);
});
