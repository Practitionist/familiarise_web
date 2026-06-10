/**
 * Captured-but-uncredited wallet top-up reconciler (GitHub Actions wrapper) —
 * #785, task #23. Re-credits gateway-captured top-ups whose confirm/ledger post
 * rolled back (capturedAt set, still PENDING). Runs every 30 minutes.
 */
import {
  sweepOrphanedTopupCaptures,
  disconnectDatabase,
  type TopupCaptureSweepResult,
} from "../../scripts/cleanup/sweep-orphaned-topup-captures";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

function outputToGitHubActions(result: TopupCaptureSweepResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `scanned=${result.scanned}`,
      `recredited=${result.recredited}`,
      `still_failing=${result.stillFailing}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }
  if (result.recredited > 0) {
    console.log(`::notice::Re-credited ${result.recredited} captured top-up(s)`);
  }
  if (result.stillFailing > 0) {
    console.log(
      `::warning::${result.stillFailing} captured top-up(s) still failing: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sweep-orphaned-topup-captures");
  console.log("🧹 Starting captured-but-uncredited top-up sweep...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await sweepOrphanedTopupCaptures();
    console.log("\n📊 Job Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Re-credited: ${result.recredited}`);
    console.log(`   Still failing: ${result.stillFailing}`);
    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }
    outputToGitHubActions(result);
  } catch (error) {
    // #476 — lock held = another run is live; skipping is the correct
    // outcome (exit 0, no page). CronLockUnavailableError falls through
    // to exit 1 so the workflow's notify step pages.
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      return;
    }
    console.error("❌ Fatal error in captured-top-up sweep:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
