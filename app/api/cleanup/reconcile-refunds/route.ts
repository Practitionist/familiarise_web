/**
 * Refund Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-pending-refunds.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import {
  notifyFailedRefunds,
  reconcilePendingRefunds,
} from "@/scripts/refunds/reconcile-pending-refunds";

export const { GET, POST } = cleanupRoute({
  // Must be the canonical cron job name: `assertNotInMaintenance` keys the
  // DEGRADED branch on FINANCIAL_JOB_NAMES membership, and "reconcile-refunds"
  // is not a member, so this financial job would have run through DEGRADED.
  job: "reconcile-pending-refunds",
  // Same two passes as the Actions job: reconcile (which can flip a stale
  // refund to FAILED), then notify payers of FAILED refunds (#1746).
  run: async (req) => {
    const result = await reconcilePendingRefunds({
      limit: parseLimitParam(req),
    });
    const failedNotify = await notifyFailedRefunds();
    return { ...result, failedNotified: failedNotify.notified };
  },
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    failedCount: r.failedCount,
    skippedCount: r.skippedCount,
    skippedFenced: r.skippedFenced,
    failedUnknownId: r.failedUnknownId,
    failedNotified: r.failedNotified,
  }),
  // #1458 — a fenced-gateway skip is a healthy run with something an operator
  // should know about: PENDING refunds exist on a rail this deployment does not
  // poll. 207 says exactly that, where the old behaviour was a 500 because every
  // fenced row threw and landed in `errors`.
  status: (r) => statusFor(r, r.skippedFenced > 0),
  // #1390 review — the constant 200 masked a caught job error (success:false)
  // as healthy; the default statusFor already reads result.success.
  failureMessage: "Failed to reconcile refunds",
});
