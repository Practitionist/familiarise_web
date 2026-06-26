/**
 * Stream Recording Retention Job (GitHub Actions Wrapper)
 *
 * Daily at 03:00 UTC via .github/workflows/cleanup-old-stream-recordings.yml.
 * Tombstones recordings older than each org's retention window.
 */

// Why: see docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";

import {
  cleanupOldStreamRecordings,
  disconnectDatabase,
  type StreamRetentionResult,
} from "../../scripts/cleanup/cleanup-old-stream-recordings";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

function outputToGitHubActions(result: StreamRetentionResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = [
    `scanned=${result.scanned}`,
    `expired=${result.expired}`,
    `success=${result.success}`,
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  fs.appendFileSync(outputFile, lines + "\n");
}

if (require.main === module) {
  (async () => {
    await abortIfMaintenance("cleanup-old-stream-recordings");
    Sentry.logger.info("job:cleanup-old-stream-recordings started");
    console.log("🎬 Sweeping old Stream recordings...");
    try {
      const result = await cleanupOldStreamRecordings();
      console.log(JSON.stringify(result, null, 2));
      outputToGitHubActions(result);
      Sentry.logger.info("job:cleanup-old-stream-recordings finished", { scanned: result.scanned, expired: result.expired });
      if (!result.success) process.exit(1);
    } catch (err) {
      // #476 — lock held = another run is live; skip cleanly (exit 0).
      if (err instanceof CronLockHeldError) {
        Sentry.logger.info("job:cleanup-old-stream-recordings lock held, skipping");
        console.log(`⏭️  ${err.message}`);
        return;
      }
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "cleanup-old-stream-recordings" } });
      console.error("Fatal error:", err);
      process.exit(1);
    } finally {
      await disconnectDatabase();
    }
  })();
}
