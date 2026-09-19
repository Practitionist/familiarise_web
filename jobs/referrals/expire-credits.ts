/**
 * Expire Stale Credits Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/referrals/expire-credits.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily via scheduled workflow (#1757 — the script had never been
 * scheduled, so expired credits kept a non-zero `remainingAmount` forever).
 */

import {
  expireCredits,
  disconnectDatabase,
  type ExpireCreditsResult,
} from "../../scripts/referrals/expire-credits";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: ExpireCreditsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `expired_count=${result.expiredCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.expiredCount > 0) {
    console.log(`::notice::Expired ${result.expiredCount} stale credit(s)`);
  }

  if (!result.success) {
    console.log(
      `::warning::Credit expiry had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("expire-credits");
  Sentry.logger.info("job:expire-credits started");
  console.log("🔄 Starting credit expiry job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await expireCredits();

    console.log("\n📊 Job Results:");
    console.log(`   Expired: ${result.expiredCount}`);
    console.log(`   Success: ${result.success}`);

    outputToGitHubActions(result);

    Sentry.logger.info("job:expire-credits finished", {
      expiredCount: result.expiredCount,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("expire-credits", main);
