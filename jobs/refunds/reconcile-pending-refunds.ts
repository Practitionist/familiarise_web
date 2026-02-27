/**
 * Refund Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-pending-refunds.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  reconcilePendingRefunds,
  disconnectDatabase,
  type RefundReconciliationResult,
} from "../../scripts/refunds/reconcile-pending-refunds";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: RefundReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `failed_count=${result.failedCount}`,
      `skipped_count=${result.skippedCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Refund reconciliation completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-pending-refunds");
  console.log("🔄 Starting refund reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcilePendingRefunds();

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Failed: ${result.failedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Fatal error in refund reconciliation:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
