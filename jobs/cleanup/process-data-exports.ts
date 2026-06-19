/**
 * Data Export Worker (GitHub Actions Wrapper)
 *
 * Every 10 minutes via .github/workflows/process-data-exports.yml.
 */

import "dotenv/config";

import {
  processDataExports,
  disconnectDatabase,
  type DataExportResult,
} from "../../scripts/cleanup/process-data-exports";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

function outputToGitHubActions(result: DataExportResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = [
    `picked=${result.picked}`,
    `succeeded=${result.succeeded}`,
    `failed=${result.failed}`,
    `success=${result.success}`,
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  fs.appendFileSync(outputFile, lines + "\n");
}

if (require.main === module) {
  (async () => {
    await abortIfMaintenance("process-data-exports");
    Sentry.logger.info("job:process-data-exports started");
    console.log("📦 Processing data export queue...");
    try {
      const result = await processDataExports();
      console.log(JSON.stringify(result, null, 2));
      outputToGitHubActions(result);
      if (result.success) {
        Sentry.logger.info("job:process-data-exports finished", { picked: result.picked, succeeded: result.succeeded, failed: result.failed });
      }
      if (!result.success) process.exit(1);
    } catch (err) {
      // #476 — lock held = another run is live; skip cleanly (exit 0).
      if (err instanceof CronLockHeldError) {
        Sentry.logger.info("job:process-data-exports lock held — skipping");
        console.log(`⏭️  ${err.message}`);
        return;
      }
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "process-data-exports" } });
      console.error("Fatal error:", err);
      process.exit(1);
    } finally {
      await disconnectDatabase();
    }
  })();
}
