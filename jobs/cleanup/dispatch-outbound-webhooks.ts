/**
 * Outbound Webhook Dispatch Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/dispatch-outbound-webhooks.ts.
 * Adds GitHub Actions-specific stdout output and exit-code mapping.
 *
 * Runs every minute via .github/workflows/dispatch-outbound-webhooks.yml.
 */

// Why: tsx does not auto-load .env when run outside the Next.js runtime;
// without dotenv/config DATABASE_URL is undefined and PrismaClient throws.
// See docs/enterprise/23-runbooks.md "Running cron jobs locally".
import "dotenv/config";

import {
  dispatchOutboundWebhooks,
  disconnectDatabase,
  type DispatchOutboundWebhooksResult,
} from "../../scripts/cleanup/dispatch-outbound-webhooks";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

function outputToGitHubActions(result: DispatchOutboundWebhooksResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;

  const outputs = [
    `scanned=${result.scanned}`,
    `succeeded=${result.succeeded}`,
    `retried=${result.retried}`,
    `failed=${result.failed}`,
    `success=${result.success}`,
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  fs.appendFileSync(outputFile, outputs + "\n");
}

if (require.main === module) {
  (async () => {
    await abortIfMaintenance("dispatch-outbound-webhooks");
    console.log("📤 Dispatching outbound webhooks...");
    try {
      const result = await dispatchOutboundWebhooks();
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
