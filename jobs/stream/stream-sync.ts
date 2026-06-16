/**
 * Stream User Sync Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/stream/stream-sync.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily via scheduled workflow (03:40 UTC / 09:10 IST; #709 minute map).
 */

import {
  performStreamUserSync,
  printSyncSummary,
  disconnectDatabase,
  type SyncSummary,
} from "../../scripts/stream/stream-sync";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(summary: SyncSummary): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `users_processed=${summary.totalStreamUsersProcessed}`,
      `stale_identified=${summary.totalStaleUsersIdentified}`,
      `users_deleted=${summary.totalStaleUsersDeleted}`,
      `failed_deletions=${summary.totalFailedDeletions}`,
      `success=${summary.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (summary.totalStaleUsersDeleted > 0) {
    console.log(
      `::notice::Cleaned up ${summary.totalStaleUsersDeleted} stale Stream users`,
    );
  }

  if (!summary.success) {
    const errors = summary.failedDeletionDetails
      .slice(0, 5)
      .map((f) => f.id)
      .join(", ");
    console.log(
      `::warning::Stream sync had ${summary.totalFailedDeletions} failures: ${errors}${summary.totalFailedDeletions > 5 ? "..." : ""}`,
    );
  }
}

/**
 * Main entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("stream-sync");
  const startTime = Date.now();
  console.log("🚀 Starting Stream user sync job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  // Check for dry run flag
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("   Mode: DRY RUN");
  }

  try {
    const result = await performStreamUserSync({ dryRun });

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    printSyncSummary(result);
    outputToGitHubActions(result);

    if (!result.success) {
      console.error("\n❌ Job completed with some failures");
      process.exit(1);
    }

    console.log("\n🎉 Job completed successfully");
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("💥 Job failed:", errorMessage);

    if (process.env.GITHUB_ACTIONS) {
      const outputFile = process.env.GITHUB_OUTPUT;
      if (outputFile) {
        fs.appendFileSync(outputFile, "success=false\n");
      }
      console.log(`::error::Stream sync job failed: ${errorMessage}`);
    }

    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Run the job
main().catch((error) => {
  console.error("\n❌ Unexpected error:", error);
  process.exit(1);
});
