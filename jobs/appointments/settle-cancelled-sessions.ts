/**
 * Settle Cancelled Class Sessions Job (GitHub Actions wrapper, #1780 row 4)
 *
 * Thin wrapper around scripts/appointments/settle-cancelled-sessions.ts; the
 * five-minute ticker drives the same core through its HTTP twin, and this
 * run is the unbounded backstop.
 */

import * as Sentry from "@sentry/nextjs";

import { settleCancelledSessions } from "../../scripts/appointments/settle-cancelled-sessions";
import prisma from "../../lib/prisma";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

async function main(): Promise<void> {
  await abortIfMaintenance("settle-cancelled-sessions");
  Sentry.logger.info("job:settle-cancelled-sessions started");
  try {
    const result = await settleCancelledSessions({ limit: 200 });
    console.log(
      `Settled cancelled class sessions: scanned ${result.scanned}, stamped ${result.stamped}, refunded ${result.refunded}, errors ${result.errors}`,
    );
    Sentry.logger.info("job:settle-cancelled-sessions finished", {
      scanned: result.scanned,
      stamped: result.stamped,
      refunded: result.refunded,
      errors: result.errors,
    });
    if (!result.success) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

runJob("settle-cancelled-sessions", main);
