/**
 * Orphaned Org Credit Purchase Cleanup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/enterprise/cleanup-orphaned-org-credit-purchases.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily at 02:00 UTC via scheduled workflow.
 */

import {
  cleanupOrphanedOrgCreditPurchases,
  disconnectDatabase,
  type OrphanedPurchaseCleanupResult,
} from "../../scripts/enterprise/cleanup-orphaned-org-credit-purchases";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

function outputToGitHubActions(result: OrphanedPurchaseCleanupResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `cancelled_count=${result.cancelledCount}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Orphaned purchase cleanup completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-orphaned-org-credit-purchases");
  const startTime = Date.now();
  console.log(`🚀 Starting orphaned org credit purchase cleanup at ${new Date().toISOString()}`);

  try {
    const result = await cleanupOrphanedOrgCreditPurchases();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️  Job completed in ${duration.toFixed(2)} seconds`);
    console.log(`\n📊 Summary:`);
    console.log(`   🗑️  Cancelled: ${result.cancelledCount}`);
    console.log(`   ✅ Success:   ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️  Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    if (result.success) {
      console.log("\n🎉 Job completed successfully");
      process.exit(0);
    } else {
      console.error("\n❌ Job completed with errors");
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("💥 Job failed:", message);

    if (process.env.GITHUB_ACTIONS) {
      const outputFile = process.env.GITHUB_OUTPUT;
      if (outputFile) fs.appendFileSync(outputFile, "success=false\n");
      console.log(`::error::Job failed: ${message}`);
    }

    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error("\n❌ Job failed:");
  console.error(error);
  process.exit(1);
});
