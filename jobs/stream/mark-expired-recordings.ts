/**
 * Mark Expired Recordings Job (GitHub Actions Wrapper)
 *
 * Marks Stream S3 recordings whose URLs have expired as EXPIRED status.
 *
 * Runs daily via scheduled workflow.
 */

import * as Sentry from "@sentry/nextjs";
import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import {
  withCronLock,
  CronLockHeldError,
} from "../../lib/cron/with-cron-lock";
import fs from "fs";

async function main(): Promise<void> {
  await abortIfMaintenance("mark-expired-recordings");
  Sentry.logger.info("job:mark-expired-recordings started");
  const startTime = Date.now();
  console.log("🚀 Starting mark-expired-recordings job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  try {
    // #476 — entry-level cron lock; fail-open (repeat-safe side effects).
    const expiredCount = await withCronLock(
      "mark-expired-recordings",
      { failMode: "open" },
      () => RecordingTransferService.markExpiredRecordings(),
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
    console.log(`   Recordings marked expired: ${expiredCount}`);

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `expired_count=${expiredCount}\nsuccess=true\n`,
      );
    }

    Sentry.logger.info("job:mark-expired-recordings finished", { expiredCount });
    console.log("🎉 Job completed successfully");
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      Sentry.logger.info("job:mark-expired-recordings lock held, skipping");
      console.log(`⏭️  ${error.message}`);
      return;
    }
    Sentry.captureException(error, { tags: { subsystem: "jobs", job: "mark-expired-recordings" } });
    console.error("💥 Job failed:", error);
    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "success=false\n");
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
