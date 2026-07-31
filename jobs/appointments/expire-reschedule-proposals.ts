/**
 * Reschedule Proposal Expiry Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/appointments/expire-reschedule-proposals.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  expireRescheduleProposals,
  type RescheduleProposalExpiryResult,
} from "../../scripts/appointments/expire-reschedule-proposals";
import prisma from "../../lib/prisma";
import fs from "node:fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: RescheduleProposalExpiryResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `proposals_expired=${result.proposalsExpired}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.proposalsExpired > 0) {
    console.log(
      `::notice::Expired ${result.proposalsExpired} reschedule proposals`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Reschedule proposal expiry had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("expire-reschedule-proposals");
  Sentry.logger.info("job:expire-reschedule-proposals started");
  console.log("🕐 Starting reschedule proposal expiry job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await expireRescheduleProposals();

    console.log("\n📊 Job Results:");
    console.log(`   Proposals Expired: ${result.proposalsExpired}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:expire-reschedule-proposals finished", {
      proposalsExpired: result.proposalsExpired,
    });

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      Sentry.logger.info("job:expire-reschedule-proposals lock held, skipping");
      console.log(`⏭️  ${error.message}`);
      return;
    }
    Sentry.captureException(error, {
      tags: { subsystem: "jobs", job: "expire-reschedule-proposals" },
    });
    console.error("❌ Fatal error in reschedule proposal expiry:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
