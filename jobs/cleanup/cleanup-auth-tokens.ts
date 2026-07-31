/**
 * Auth Token Cleanup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup-auth-tokens.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily at midnight via scheduled workflow.
 */

import {
  cleanupAuthTokens,
  disconnectDatabase,
  type AuthTokenCleanupResult,
} from "../../scripts/cleanup/cleanup-auth-tokens";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: AuthTokenCleanupResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `verification_tokens_deleted=${result.verificationTokensDeleted}`,
      `sessions_deleted=${result.sessionsDeleted}`,
      `password_reset_tokens_cleared=${result.passwordResetTokensCleared}`,
      `total_cleaned=${result.totalCleaned}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Auth token cleanup completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-auth-tokens");
  Sentry.logger.info("job:cleanup-auth-tokens started");
  console.log("🧹 Starting auth token cleanup job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cleanupAuthTokens();

    console.log("\n📊 Cleanup Results:");
    console.log(`   Verification Tokens: ${result.verificationTokensDeleted}`);
    console.log(`   Sessions: ${result.sessionsDeleted}`);
    console.log(
      `   Password Reset Tokens: ${result.passwordResetTokensCleared}`,
    );
    console.log(`   Total Cleaned: ${result.totalCleaned}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:cleanup-auth-tokens finished", {
      verificationTokensDeleted: result.verificationTokensDeleted,
      sessionsDeleted: result.sessionsDeleted,
      passwordResetTokensCleared: result.passwordResetTokensCleared,
      totalCleaned: result.totalCleaned,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      Sentry.logger.info("job:cleanup-auth-tokens skipped — cron lock held");
      console.log(`⏭️  ${error.message}`);
      return;
    }
    Sentry.captureException(error, { tags: { subsystem: "jobs", job: "cleanup-auth-tokens" } });
    console.error("❌ Fatal error in auth token cleanup:", error);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

runJob("cleanup-auth-tokens", main);
