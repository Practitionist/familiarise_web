// This script is intended to be run directly by Node.js, e.g., by a GitHub Action.
import { performStreamUserSync, SyncSummary } from "./stream-sync"; // Relative path for local script

// Immediately-invoked async function (IIFE) to use await
(async () => {
  console.log("[Run Stream Sync Script] Starting execution...");

  // Ensure required environment variables for Prisma are set if not already handled by Next.js context
  // For GitHub Actions, these will need to be explicitly provided as secrets/env vars.
  if (!process.env.DATABASE_URL) {
    console.error(
      "[Run Stream Sync Script] Critical: DATABASE_URL environment variable is not set.",
    );
    process.exit(1);
  }
  // The stream-sync module itself checks for Stream API keys.

  try {
    const summary: SyncSummary = await performStreamUserSync();

    console.log("[Run Stream Sync Script] Synchronization completed.");
    console.log("--- Summary ---");
    console.log(
      `Total Stream Users Processed: ${summary.totalStreamUsersProcessed}`,
    );
    console.log(
      `Total Stale Users Identified: ${summary.totalStaleUsersIdentified}`,
    );
    console.log(
      `Total Stale Users Deleted:    ${summary.totalStaleUsersDeleted}`,
    );
    console.log(
      `Total Failed Deletions:       ${summary.totalFailedDeletions}`,
    );

    if (
      summary.failedDeletionDetails &&
      summary.failedDeletionDetails.length > 0
    ) {
      console.warn("--- Failed Deletion Details ---");
      summary.failedDeletionDetails.forEach((failure) => {
        console.warn(`  User ID: ${failure.id}, Error: ${failure.error}`);
      });
    }

    if (summary.totalFailedDeletions > 0) {
      console.warn(
        "[Run Stream Sync Script] Process completed with some failed deletions.",
      );
      // Optionally, exit with a different code for partial success if needed by CI
      // process.exit(2);
    }

    console.log("[Run Stream Sync Script] Execution finished successfully.");
    process.exit(0);
  } catch (error: any) {
    console.error(
      "[Run Stream Sync Script] An error occurred during the synchronization process:",
    );
    console.error(error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1); // Exit with a failure code
  }
})();
