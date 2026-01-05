/**
 * Auto-Complete Appointments Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/auto-complete-appointments.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  autoCompleteAppointments,
  disconnectDatabase,
  type AutoCompleteResult,
} from "../../scripts/appointments/auto-complete-appointments";
import fs from "fs";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: AutoCompleteResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `webinars_completed=${result.webinarsCompleted}`,
      `classes_completed=${result.classesCompleted}`,
      `consultations_identified=${result.consultationsIdentified}`,
      `subscriptions_identified=${result.subscriptionsIdentified}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  const total = result.webinarsCompleted + result.classesCompleted;
  if (total > 0) {
    console.log(
      `::notice::Auto-completed ${total} appointments (${result.webinarsCompleted} webinars, ${result.classesCompleted} classes)`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Auto-complete had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log("⏰ Starting auto-complete appointments job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await autoCompleteAppointments();

    console.log("\n📊 Job Results:");
    console.log(`   Webinars Completed: ${result.webinarsCompleted}`);
    console.log(`   Classes Completed: ${result.classesCompleted}`);
    console.log(`   Consultations Identified: ${result.consultationsIdentified}`);
    console.log(`   Subscriptions Identified: ${result.subscriptionsIdentified}`);
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
    console.error("❌ Fatal error in auto-complete appointments:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
