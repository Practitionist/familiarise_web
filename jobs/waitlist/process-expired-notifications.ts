/**
 * Process Waitlist Expirations Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/waitlist/process-expired-notifications.ts
 * (#856 — this file previously held a full duplicate implementation; the
 * script's core is now the single source).
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly at :05 via scheduled workflow.
 */

import {
  processWaitlistExpirations,
  disconnectDatabase,
  type ProcessExpirationsResult,
} from "../../scripts/waitlist/process-expired-notifications";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

function outputToGitHubActions(result: ProcessExpirationsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `processed=${result.processed}`,
      `emailed=${result.emailed}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::warning::Waitlist expiration processing had errors: ${result.errors
        .map((e) => `${e.id}: ${e.error}`)
        .join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("process-expired-notifications");
  console.log("🕐 Starting expired notification processor...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await processWaitlistExpirations();

    console.log("\n📊 Job Results:");
    console.log(`   Processed: ${result.processed}`);
    console.log(`   Emails sent: ${result.emailed}`);
    console.log(`   Errors: ${result.errors.length}`);

    outputToGitHubActions(result);

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      return;
    }
    console.error("❌ Error processing expired notifications:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Run the job — the catch covers rejections that escape main's own
// try/catch (e.g. abortIfMaintenance), matching the payouts wrapper.
main().catch((error) => {
  console.error("❌ expired notification job failed:");
  console.error(error);
  process.exit(1);
});
