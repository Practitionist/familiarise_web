/**
 * Dispute Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-disputes.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 6 hours via scheduled workflow.
 */

import {
  reconcileDisputes,
  disconnectDatabase,
  type DisputeReconciliationResult,
} from "../../scripts/disputes/reconcile-disputes";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: DisputeReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `urgent_count=${result.urgentCount}`,
      `razorpay_manual_review=${result.razorpayManualReviewCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.urgentCount > 0) {
    console.log(
      `::warning::${result.urgentCount} disputes require immediate attention (deadline within 48 hours)!`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Dispute reconciliation completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-disputes");
  console.log("🔄 Starting dispute reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcileDisputes();

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Urgent (48h deadline): ${result.urgentCount}`);
    console.log(
      `   Razorpay Manual Review: ${result.razorpayManualReviewCount}`,
    );
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
    console.error("❌ Fatal error in dispute reconciliation:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
