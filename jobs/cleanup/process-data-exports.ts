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
    console.log("📦 Processing data export queue...");
    try {
      const result = await processDataExports();
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
