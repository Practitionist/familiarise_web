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
import {
  recordSystemEvent,
  recordSystemError,
} from "../../lib/enterprise/system-events";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

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
      `skipped_count=${result.skippedCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.log(
      `::warning::Razorpay credentials not configured — Razorpay records were skipped`,
    );
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
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    // #776 §K — stuck/failed payouts mean a consultant isn't getting paid;
    // page on it rather than leaving it in CI logs.
    if (result.failedCount > 0 || !result.success) {
      await recordSystemEvent({
        category: "PAYOUT",
        severity: "ERROR",
        message: `Stuck-payout handler: ${result.failedCount} permanently failed, success=${result.success}`,
        context: {
          totalProcessed: result.totalProcessed,
          failedCount: result.failedCount,
          retriedCount: result.retriedCount,
          errors: result.errors,
        },
      });
    }

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    // #476 — lock held = another run is live; skipping is the correct
    // outcome (exit 0, no page). CronLockUnavailableError falls through
    // to exit 1 so the workflow's notify step pages.
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      return;
    }
    console.error("❌ Fatal error in stuck payouts handler:", error);
    await recordSystemError({
      category: "PAYOUT",
      summary: "Stuck-payout handler crashed",
      err: error,
    });
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
