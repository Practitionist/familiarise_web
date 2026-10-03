/**
 * Orphaned Meeting Session Reconciliation Job
 * Reconciles open Meeting records whose occurrence ended over 1 hour ago and closes dangling presence rows.
 */

import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import {
  reconcileOrphanedSessions,
  type ReconciliationResult,
} from "../../lib/meetings/reconcile-orphaned-sessions";

export { reconcileOrphanedSessions, type ReconciliationResult };

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

if (require.main === module) {
  runJob("reconcile-orphaned-sessions", async () => {
    await abortIfMaintenance("reconcile-orphaned-sessions");
    Sentry.logger.info("job:reconcile-orphaned-sessions started");
    console.log("Starting orphaned session reconciliation...");

    try {
      const result = await reconcileOrphanedSessions();
      console.log("\nReconciliation Results:");
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Reconciled: ${result.reconciled}`);
      console.log(`  Stream Not Found: ${result.streamNotFound}`);
      console.log(`  Errors: ${result.errors}`);
      console.log(`  Success: ${result.success}`);

      Sentry.logger.info("job:reconcile-orphaned-sessions finished", {
        processed: result.processed,
        reconciled: result.reconciled,
        streamNotFound: result.streamNotFound,
        errors: result.errors,
      });
      if (!result.success) process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  });
}
