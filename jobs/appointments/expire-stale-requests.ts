/**
 * Stale Request Expiration Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/expire-stale-requests.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily via scheduled workflow.
 */

import {
  expireStaleRequests,
  disconnectDatabase,
  type ExpireStaleRequestsResult,
} from "../../scripts/appointments/expire-stale-requests";
import fs from "fs";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: ExpireStaleRequestsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `consultations_expired=${result.consultationsExpired}`,
      `subscriptions_expired=${result.subscriptionsExpired}`,
      `payment_pending_expired=${result.paymentPendingExpired}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  const total =
    result.consultationsExpired +
    result.subscriptionsExpired +
    result.paymentPendingExpired;

  if (total > 0) {
    console.log(`::notice::Expired ${total} stale requests`);
  }

  if (!result.success) {
    console.log(
      `::warning::Stale request expiration had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log("🕐 Starting stale request expiration job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await expireStaleRequests();

    console.log("\n📊 Job Results:");
    console.log(`   Consultations Expired: ${result.consultationsExpired}`);
    console.log(`   Subscriptions Expired: ${result.subscriptionsExpired}`);
    console.log(`   Payment Pending Expired: ${result.paymentPendingExpired}`);
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
    console.error("❌ Fatal error in stale request expiration:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
