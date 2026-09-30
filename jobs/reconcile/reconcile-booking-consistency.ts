/**
 * Booking Consistency Reconcile Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile/reconcile-booking-consistency.ts.
 *
 * Runs nightly. The Netlify ticker does NOT drive it: this is a DETECTOR, not
 * a sweep, so a daily cadence costs one run a day against the Upstash budget
 * #1792 documented, and there is nothing a customer is waiting on — the
 * difference from the sweeps the ticker carries, which each gate a payment, a
 * refund, a reminder or a hold.
 *
 * #1846 — the same posture reconcile-occurrence-availability takes: a finding
 * is signal, not failure. Only a real error exits non-zero, because a job that
 * fails nightly on known rows stops being read.
 */

import fs from "fs";
import {
  reconcileBookingConsistency,
  disconnectDatabase,
  type ReconcileBookingConsistencyResult,
} from "../../scripts/reconcile/reconcile-booking-consistency";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

/** Findings echoed into the Actions log, bounded so a bad night cannot flood it. */
const LOGGED_FINDINGS = 20;

function outputToGitHubActions(result: ReconcileBookingConsistencyResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `payments_checked=${result.paymentsChecked}`,
      `paid_without_live_seat=${result.paidWithoutLiveSeat}`,
      `newly_recorded=${result.newlyRecorded}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, `${outputs}\n`);
  }

  if (result.paidWithoutLiveSeat > 0) {
    console.log(
      `::notice::${result.paidWithoutLiveSeat} payment(s) with no live seat — recorded as SystemEvents under category BOOKING`,
    );
    for (const finding of result.findings.slice(0, LOGGED_FINDINGS)) {
      console.log(
        `::notice::   ${finding.paymentId} user=${finding.userId} seat=${String(finding.detail.seatStatus ?? "none")} outstanding=${finding.outstandingPaise}`,
      );
    }
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-booking-consistency");
  console.log("🔎 Starting booking consistency reconcile job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcileBookingConsistency();

    console.log("\n📊 Job Results:");
    console.log(`   Payments checked: ${result.paymentsChecked}`);
    console.log(`   Paid without a live seat: ${result.paidWithoutLiveSeat}`);
    console.log(`   Newly recorded: ${result.newlyRecorded}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    if (!result.success) process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-booking-consistency", main);
