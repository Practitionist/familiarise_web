/**
 * Slot Availability Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-slot-availability.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  reconcileSlotAvailability,
  disconnectDatabase,
  type SlotReconciliationResult,
} from "../../scripts/appointments/reconcile-slot-availability";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: SlotReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `tentative_cleared=${result.tentativeFlagsCleared}`,
      `double_bookings=${result.doubleBookingsDetected}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.tentativeFlagsCleared > 0) {
    console.log(
      `::notice::Cleared tentative flag on ${result.tentativeFlagsCleared} slots`,
    );
  }

  if (result.doubleBookingsDetected > 0) {
    console.log(
      `::error::${result.doubleBookingsDetected} DOUBLE BOOKINGS detected - manual intervention required!`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Slot reconciliation had issues: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-slot-availability");
  console.log("🔄 Starting slot availability reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcileSlotAvailability();

    console.log("\n📊 Job Results:");
    console.log(`   Tentative Flags Cleared: ${result.tentativeFlagsCleared}`);
    console.log(
      `   Double Bookings Detected: ${result.doubleBookingsDetected}`,
    );
    console.log(`   Success: ${result.success}`);

    if (result.doubleBookings.length > 0) {
      console.log("\n🚨 Double Bookings:");
      result.doubleBookings.forEach((db) => {
        console.log(`   - ${db.consultantName}: ${db.slotTime}`);
        console.log(`     Appointments: ${db.appointments.join(", ")}`);
      });
      // Structured JSON for monitoring integration (PagerDuty, Datadog, etc.)
      console.log(
        JSON.stringify({
          event: "double_bookings_detected",
          count: result.doubleBookingsDetected,
          bookings: result.doubleBookings,
          timestamp: new Date().toISOString(),
          severity: "critical",
        }),
      );
    }

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    // Exit with error if double bookings found (to trigger alerts)
    if (result.doubleBookingsDetected > 0) {
      process.exit(1);
    }

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Fatal error in slot reconciliation:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
