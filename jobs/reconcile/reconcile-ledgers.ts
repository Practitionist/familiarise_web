/**
 * Ledger Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile/reconcile-ledgers.ts. The core
 * auditor is pure + read-only so the same function is invoked from:
 *   1. This GitHub Actions cron (scheduled nightly).
 *   2. The admin trigger route at
 *      `POST /api/admin/reconcile-ledgers` when ops wants an on-demand
 *      run (e.g. after a suspected webhook outage).
 *
 * Exit behaviour:
 *   0 — clean report (no discrepancies)
 *   1 — fatal error (auditor threw)
 *   2 — report written but had discrepancies (turns the workflow red so
 *       GitHub alerting can page ops)
 */

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runReconcileLedgers } from "../../scripts/reconcile/reconcile-ledgers";
import prisma from "../../lib/prisma";

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-ledgers");
  console.log("🔎 Starting ledger reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const report = await runReconcileLedgers({ scope: "full" });

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Report id:   ${report.id}`);
    console.log(`   Scope:       ${report.scope}`);
    console.log(`   Clean:       ${report.ok}`);
    console.log(`   Duration:    ${report.durationMs}ms`);
    console.log(`   Orgs:        ${report.summary.orgsChecked}`);
    console.log(`   Accounts:    ${report.summary.accountsChecked}`);
    console.log(
      `   Findings:    ${report.summary.discrepanciesCount}`,
    );

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        [
          `report_id=${report.id}`,
          `clean=${report.ok}`,
          `findings=${report.summary.discrepanciesCount}`,
          `duration_ms=${report.durationMs}`,
        ].join("\n") + "\n",
      );
    }

    if (!report.ok) {
      console.log("\n⚠️  Discrepancies:");
      for (const f of report.findings) {
        console.log(`   · ${f.kind}: ${JSON.stringify(f)}`);
      }
      console.log(
        `::error::Ledger reconciliation found ${report.summary.discrepanciesCount} discrepancies. Report id: ${report.id}`,
      );
      process.exit(2);
    }
  } catch (error) {
    console.error("❌ Fatal error in ledger reconciliation:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
