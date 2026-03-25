/**
 * Send Appointment Reminders Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/send-appointment-reminders.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  sendAppointmentReminders,
  disconnectDatabase,
  type ReminderResult,
} from "../../scripts/appointments/send-appointment-reminders";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: ReminderResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `reminders_24h=${result.reminders24h}`,
      `reminders_1h=${result.reminders1h}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  const total = result.reminders24h + result.reminders1h;
  if (total > 0) {
    console.log(
      `::notice::Sent ${total} appointment reminders (${result.reminders24h} 24h, ${result.reminders1h} 1h)`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Appointment reminders had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("send-appointment-reminders");
  console.log("⏰ Starting appointment reminders job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await sendAppointmentReminders();

    console.log("\n📊 Job Results:");
    console.log(`   24h Reminders Sent: ${result.reminders24h}`);
    console.log(`   1h Reminders Sent: ${result.reminders1h}`);
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
    console.error("❌ Fatal error in appointment reminders:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
