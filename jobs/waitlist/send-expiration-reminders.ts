/**
 * Send Waitlist Reminders Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/waitlist/send-expiration-reminders.ts (#856 —
 * this file previously held a full duplicate implementation that had already
 * drifted from the script; the script's core is now the single source).
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly at :30 via scheduled workflow.
 */

import {
  sendExpirationReminders,
  disconnectDatabase,
  type SendRemindersResult,
} from "../../scripts/waitlist/send-expiration-reminders";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

function outputToGitHubActions(result: SendRemindersResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `found=${result.found}`,
      `sent=${result.sent}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::warning::Waitlist reminders had errors: ${result.errors
        .map((e) => `${e.id}: ${e.error}`)
        .join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("send-expiration-reminders");
  console.log("🔔 Starting expiration reminder sender...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await sendExpirationReminders();

    console.log("\n📊 Job Results:");
    console.log(`   Found: ${result.found}`);
    console.log(`   Sent: ${result.sent}`);
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
    console.error("❌ Error sending expiration reminders:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Run the job — the catch covers rejections that escape main's own
// try/catch (e.g. abortIfMaintenance), matching the payouts wrapper.
main().catch((error) => {
  console.error("❌ expiration reminder job failed:");
  console.error(error);
  process.exit(1);
});
