/**
 * Stuck Payouts Handler Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/handle-stuck-payouts.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 4 hours via scheduled workflow.
 */

import {
  handleStuckPayouts,
  disconnectDatabase,
  type StuckPayoutsResult,
} from "../../scripts/payouts/handle-stuck-payouts";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: StuckPayoutsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `retried_count=${result.retriedCount}`,
      `failed_count=${result.failedCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.failedCount > 0) {
    console.log(
      `::warning::${result.failedCount} payouts permanently failed after max retries`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Stuck payouts handler completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("handle-stuck-payouts");
  console.log("🔄 Starting stuck payouts handler job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await handleStuckPayouts();

    console.log("\n📊 Handler Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Retried: ${result.retriedCount}`);
    console.log(`   Failed: ${result.failedCount}`);
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
    console.error("❌ Fatal error in stuck payouts handler:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
