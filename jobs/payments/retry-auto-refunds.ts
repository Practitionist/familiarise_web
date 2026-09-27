/**
 * Retry Auto-Refunds Job (GitHub Actions wrapper, #1846 N2)
 *
 * Thin wrapper around scripts/payments/retry-auto-refunds.ts; the five-minute
 * ticker drives the same core through its HTTP twin, and this run is the
 * larger-bite backstop.
 */

import * as Sentry from "@sentry/nextjs";

import { retryAutoRefunds } from "../../scripts/payments/retry-auto-refunds";
import prisma from "../../lib/prisma";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

async function main(): Promise<void> {
  await abortIfMaintenance("retry-auto-refunds");
  Sentry.logger.info("job:retry-auto-refunds started");
  try {
    const result = await retryAutoRefunds({ limit: 100 });
    console.log(
      `Retried auto-refunds: scanned ${result.scanned}, refunded ${result.refunded}, settled ${result.settled}, failed ${result.failed}, stuck ${result.stuck.length}, errors ${result.errors}`,
    );
    Sentry.logger.info("job:retry-auto-refunds finished", {
      scanned: result.scanned,
      refunded: result.refunded,
      settled: result.settled,
      failed: result.failed,
      stuck: result.stuck.length,
      errors: result.errors,
    });
    if (!result.success) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

runJob("retry-auto-refunds", main);
