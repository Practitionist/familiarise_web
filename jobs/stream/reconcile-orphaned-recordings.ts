/**
 * Orphaned Recording Reconciliation Job (GitHub Actions Wrapper)
 *
 * Recovers `Recording` rows for sessions whose `call.recording_ready` webhook
 * never landed. Stream deletes the file fourteen days after the call, so the
 * window in which this is repairable is finite and the loss is permanent
 * afterwards — see the core for the full reasoning (#1270).
 *
 * Runs daily via .github/workflows/reconcile-orphaned-recordings.yml.
 */

import * as Sentry from "@sentry/nextjs";
import fs from "fs";

import { runJob } from "../../lib/observability/job-sentry";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import {
  reconcileOrphanedRecordings,
  disconnectDatabase,
} from "../../scripts/stream/reconcile-orphaned-recordings";

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-orphaned-recordings");
  Sentry.logger.info("job:reconcile-orphaned-recordings started");
  const startTime = Date.now();
  console.log("🚀 Starting reconcile-orphaned-recordings job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcileOrphanedRecordings();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
    console.log(`   Sessions scanned:    ${result.scanned}`);
    console.log(`   Recordings recovered:${result.recovered}`);
    console.log(`   Still missing:       ${result.stillMissing}`);
    console.log(`   Past Stream retention: ${result.unrecoverable}`);

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `scanned=${result.scanned}\nrecovered=${result.recovered}\n` +
          `still_missing=${result.stillMissing}\n` +
          `unrecoverable=${result.unrecoverable}\nsuccess=${result.success}\n`,
      );
    }

    // A recovery is good news about this job and bad news about the webhook:
    // the row exists now, but it only exists because a delivery was lost. Page
    // on it so the underlying dropped-webhook rate stays visible rather than
    // being quietly absorbed by the sweep that repairs it.
    if (result.recovered > 0) {
      Sentry.captureMessage("Recovered recordings a webhook never delivered", {
        level: "warning",
        tags: { subsystem: "jobs", job: "reconcile-orphaned-recordings" },
        extra: { recovered: result.recovered, scanned: result.scanned },
      });
    }

    // These are gone. Stream has deleted the file, so no future run can
    // recover them; the count only grows, and it is the honest measure of what
    // the missing webhook secret cost.
    if (result.unrecoverable > 0) {
      console.warn(
        `⚠️ ${result.unrecoverable} session(s) claim a recording that is now past Stream's retention`,
      );
      Sentry.captureMessage(
        "Recordings permanently lost past Stream retention",
        {
          level: "warning",
          tags: { subsystem: "jobs", job: "reconcile-orphaned-recordings" },
          extra: { unrecoverable: result.unrecoverable },
        },
      );
    }

    Sentry.logger.info("job:reconcile-orphaned-recordings finished", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillMissing: result.stillMissing,
      unrecoverable: result.unrecoverable,
    });

    if (!result.success) {
      console.error(
        `\n❌ Job completed with errors: ${result.errors.join("; ")}`,
      );
      process.exitCode = 1;
      return;
    }

    console.log("🎉 Job completed successfully");
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-orphaned-recordings", main);
