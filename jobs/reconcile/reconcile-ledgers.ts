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
import {
  recordSystemEvent,
  recordSystemError,
} from "../../lib/enterprise/system-events";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";

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
    console.log(`   Assignments: ${report.summary.assignmentsChecked}`);
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
      // #776 §K — surface drift to the telemetry sink, not just CI logs.
      await recordSystemEvent({
        category: "RECONCILE",
        severity: "ERROR",
        message: `Ledger reconciliation found ${report.summary.discrepanciesCount} discrepancies`,
        correlationId: report.id,
        context: {
          reportId: report.id,
          findingsCount: report.summary.discrepanciesCount,
          kinds: Array.from(new Set(report.findings.map((f) => f.kind))),
        },
      });
      process.exit(2);
    }
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      return;
    }
    console.error("❌ Fatal error in ledger reconciliation:", error);
    // #776 §K — a crashed auditor means we're flying blind on money integrity.
    await recordSystemError({
      category: "RECONCILE",
      summary: "Ledger reconciliation crashed",
      err: error,
    });
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
