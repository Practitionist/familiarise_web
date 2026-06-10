/**
 * Document Storage Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-document-storage.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily via scheduled workflow.
 */

import {
  reconcileDocumentStorage,
  disconnectDatabase,
  type DocumentReconciliationResult,
} from "../../scripts/cleanup/reconcile-document-storage";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: DocumentReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `orphaned_found=${result.orphanedFilesFound}`,
      `orphaned_deleted=${result.orphanedFilesDeleted}`,
      `missing_found=${result.missingFilesFound}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.orphanedFilesDeleted > 0) {
    console.log(
      `::notice::Deleted ${result.orphanedFilesDeleted} orphaned files from storage`,
    );
  }

  if (result.missingFilesFound > 0) {
    console.log(
      `::warning::${result.missingFilesFound} files missing from storage - manual review needed`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Document storage reconciliation failed: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-document-storage");
  console.log("📂 Starting document storage reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcileDocumentStorage();

    console.log("\n📊 Job Results:");
    console.log(`   Orphaned Files Found: ${result.orphanedFilesFound}`);
    console.log(`   Orphaned Files Deleted: ${result.orphanedFilesDeleted}`);
    console.log(`   Missing Files Found: ${result.missingFilesFound}`);
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
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      return;
    }
    console.error("❌ Fatal error in document storage reconciliation:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
