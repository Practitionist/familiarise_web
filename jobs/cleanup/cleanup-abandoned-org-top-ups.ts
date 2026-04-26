/**
 * Abandoned Organization Wallet Top-Up Cleanup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/cleanup-abandoned-org-top-ups.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily at 02:00 UTC via .github/workflows/cleanup-abandoned-org-top-ups.yml
 * (must NOT overlap subscription-cron at 00:00 UTC — Prisma connection contention).
 */

import {
  cleanupAbandonedOrgTopUps,
  disconnectDatabase,
  type AbandonedOrgTopUpCleanupResult,
} from "../../scripts/cleanup/cleanup-abandoned-org-top-ups";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

function outputToGitHubActions(result: AbandonedOrgTopUpCleanupResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `reaped=${result.reaped}`,
      `grace_hours=${result.graceHours}`,
      `cutoff=${result.cutoff}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Abandoned org top-up cleanup completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-abandoned-org-top-ups");
  console.log("🧹 Starting abandoned org top-up cleanup job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cleanupAbandonedOrgTopUps();

    console.log("\n📊 Cleanup Results:");
    console.log(`   Reaped: ${result.reaped}`);
    console.log(`   Grace window: ${result.graceHours}h`);
    console.log(`   Cutoff: ${result.cutoff}`);
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
    console.error("❌ Fatal error in abandoned org top-up cleanup:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
