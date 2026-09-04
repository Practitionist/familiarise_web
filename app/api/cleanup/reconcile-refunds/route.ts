/**
 * Refund Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-pending-refunds.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";

export const { GET, POST } = cleanupRoute({
  // Must be the canonical cron job name: `assertNotInMaintenance` keys the
  // DEGRADED branch on FINANCIAL_JOB_NAMES membership, and "reconcile-refunds"
  // is not a member, so this financial job would have run through DEGRADED.
  job: "reconcile-pending-refunds",
  run: (req) => reconcilePendingRefunds({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    failedCount: r.failedCount,
    skippedCount: r.skippedCount,
  }),
  // #1390 review — the constant 200 masked a caught job error (success:false)
  // as healthy; the default statusFor already reads result.success.
  failureMessage: "Failed to reconcile refunds",
});
