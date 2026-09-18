/**
 * Verification Housekeeping Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/sweep-verification.ts.
 * Runs daily at 08:50 IST (03:20 UTC) via
 * .github/workflows/sweep-verification.yml — offset from the other
 * early-morning sweeps so Prisma connections do not contend.
 */

import fs from "fs";
import {
  sweepVerification,
  disconnectDatabase,
  type SweepVerificationResult,
} from "../../scripts/cleanup/sweep-verification";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: SweepVerificationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(
      outputFile,
      [
        `unlinkedDeleted=${result.unlinkedDeleted}`,
        `remindersSent=${result.remindersSent}`,
        `staleClosed=${result.staleClosed}`,
        `success=${result.success}`,
      ].join("\n") + "\n",
    );
  }
  if (!result.success) {
    console.log(
      `::error::Verification sweep completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sweep-verification");
  Sentry.logger.info("job:sweep-verification started");
  console.log("🧹 Starting verification sweep...");
  try {
    const result = await sweepVerification();
    console.log("\n📊 Sweep Results:");
    console.log(`   Unlinked uploads deleted: ${result.unlinkedDeleted}`);
    console.log(`   Reminders sent: ${result.remindersSent}`);
    console.log(`   Stale requests closed: ${result.staleClosed}`);
    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }
    outputToGitHubActions(result);
    if (!result.success) {
      process.exitCode = 1;
      return;
    }
    Sentry.logger.info("job:sweep-verification finished", {
      unlinkedDeleted: result.unlinkedDeleted,
      remindersSent: result.remindersSent,
      staleClosed: result.staleClosed,
    });
  } finally {
    await disconnectDatabase();
  }
}

runJob("sweep-verification", main);
