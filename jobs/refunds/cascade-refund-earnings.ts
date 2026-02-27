/**
 * Refund-Earning Cascade Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cascade-refund-earnings.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * GitHub Issue: #305
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  cascadeRefundToEarnings,
  disconnectDatabase,
  type RefundEarningCascadeResult,
} from "../../scripts/refunds/cascade-refund-earnings";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: RefundEarningCascadeResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `updated_count=${result.updatedCount}`,
      `skipped_count=${result.skippedCount}`,
      `error_count=${result.errorCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Refund-earning cascade completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cascade-refund-earnings");
  console.log("🔄 Starting refund-earning cascade job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cascadeRefundToEarnings();

    console.log("\n📊 Cascade Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Updated: ${result.updatedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Errors: ${result.errorCount}`);
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
    console.error("❌ Fatal error in refund-earning cascade:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
