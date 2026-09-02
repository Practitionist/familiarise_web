/**
 * Refund Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-pending-refunds.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-refunds",
  run: () => reconcilePendingRefunds(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    failedCount: r.failedCount,
    skippedCount: r.skippedCount,
  }),
  status: () => 200,
  failureMessage: "Failed to reconcile refunds",
});
