/**
 * Stream Recording Retention Job (GitHub Actions Wrapper)
 *
 * Daily at 03:00 UTC via .github/workflows/cleanup-old-stream-recordings.yml.
 * Tombstones recordings older than each org's retention window.
 */

// Why: see docs/enterprise/23-runbooks.md "Running cron jobs locally".
import "dotenv/config";

import {
  cleanupOldStreamRecordings,
  disconnectDatabase,
  type StreamRetentionResult,
} from "../../scripts/cleanup/cleanup-old-stream-recordings";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

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
    console.log("🎬 Sweeping old Stream recordings...");
    try {
      const result = await cleanupOldStreamRecordings();
      console.log(JSON.stringify(result, null, 2));
      outputToGitHubActions(result);
      if (!result.success) process.exit(1);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    } finally {
      await disconnectDatabase();
    }
  })();
}
