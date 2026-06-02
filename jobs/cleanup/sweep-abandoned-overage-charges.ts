/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper (GitHub Actions wrapper) —
 * #785, task #25. FAILs never-paid PENDING side-charges so they stop counting
 * toward the per-cycle circuit-breaker ceiling. Runs daily.
 */
import {
  sweepAbandonedOverageCharges,
  disconnectDatabase,
  type OverageSweepResult,
} from "../../scripts/cleanup/sweep-abandoned-overage-charges";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

function outputToGitHubActions(result: OverageSweepResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(
      outputFile,
      [`scanned=${result.scanned}`, `failed=${result.failed}`, `success=${result.success}`].join("\n") + "\n",
    );
  }
  if (result.failed > 0) {
    console.log(`::notice::Failed ${result.failed} abandoned overage charge(s)`);
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sweep-abandoned-overage-charges");
  console.log("🧹 Starting abandoned overage-charge sweep...");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  try {
    const result = await sweepAbandonedOverageCharges();
    console.log("\n📊 Job Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Failed (ceiling freed): ${result.failed}`);
    outputToGitHubActions(result);
  } catch (error) {
    console.error("❌ Fatal error in abandoned overage-charge sweep:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
