/**
 * Process Payouts Job (GitHub Actions Version)
 *
 * Thin wrapper around the core processing logic in scripts/process-payouts.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs weekly on Mondays at 9:00 PM UTC (2:30 AM IST next day).
 */

import {
  processApprovedPayouts,
  disconnectDatabase,
  type ProcessingResult,
} from "../../scripts/payouts/process-payouts";

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions using environment files
 */
function outputToGitHubActions(result: ProcessingResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `processed=${result.processed}`,
      `succeeded=${result.succeeded}`,
      `failed=${result.failed}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    const allErrors = result.errors.join("; ");
    console.log(
      `::error::Process payouts job completed with errors: ${allErrors}`,
    );
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("process-payouts");
  const startTime = Date.now();
  console.log(
    `🚀 Starting payout processing job at ${new Date().toISOString()}`,
  );

  try {
    // Run payout processing
    const result = await processApprovedPayouts();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Summary
    console.log(`\n📊 Processing Summary:`);
    console.log(`   📤 Processed: ${result.processed}`);
    console.log(`   ✅ Succeeded: ${result.succeeded}`);
    console.log(`   ❌ Failed: ${result.failed}`);

    // Output to GitHub Actions
    outputToGitHubActions(result);

    if (result.success) {
      console.log("🎉 Payout processing job completed successfully");
      process.exit(0);
    } else {
      console.error("❌ Payout processing job completed with errors");
      process.exit(1);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("💥 Payout processing job failed:", errorMessage);

    if (process.env.GITHUB_ACTIONS) {
      const outputFile = process.env.GITHUB_OUTPUT;
      if (outputFile) {
        fs.appendFileSync(outputFile, "success=false\n");
      }
      console.log(`::error::Payout processing job failed: ${errorMessage}`);
    }

    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Run the job
main().catch((error) => {
  console.error("\n❌ Payout processing job failed:");
  console.error(error);
  process.exit(1);
});
