/**
 * Consolidated Invoice Rollup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/consolidated-invoice-rollup.ts.
 *
 * Runs monthly at 09:30 IST (04:00 UTC) on day-1 via
 *   .github/workflows/consolidated-invoice-rollup.yml
 *
 * Registered in `FINANCIAL_JOB_NAMES` in lib/maintenance-cron.ts so it
 * aborts during DEGRADED maintenance — a partial rollup would leave the
 * ledger in an inconsistent state.
 */

import fs from "fs";
import {
  runConsolidatedInvoiceRollup,
  disconnectDatabase,
  type ConsolidatedInvoiceRollupResult,
} from "../../scripts/cleanup/consolidated-invoice-rollup";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

function outputToGitHubActions(
  result: ConsolidatedInvoiceRollupResult,
): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `enabled=${result.enabled}`,
      `parents_scanned=${result.parentsScanned}`,
      `parents_rolled=${result.parentsRolled}`,
      `child_invoices_rolled=${result.childInvoicesRolled}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Consolidated invoice rollup completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("consolidated-invoice-rollup");
  console.log("🧾 Starting consolidated invoice rollup job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await runConsolidatedInvoiceRollup();

    console.log("\n📊 Rollup Results:");
    console.log(`   Enabled: ${result.enabled}`);
    console.log(`   Parents scanned: ${result.parentsScanned}`);
    console.log(`   Parents rolled: ${result.parentsRolled}`);
    console.log(`   Child invoices rolled: ${result.childInvoicesRolled}`);
    console.log(`   Success: ${result.success}`);

    if (result.skipped.length > 0) {
      console.log("\n⏭  Skipped:");
      result.skipped.forEach((s) =>
        console.log(`   - ${s.parentOrgId}: ${s.reason}`),
      );
    }

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Fatal error in consolidated invoice rollup:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
