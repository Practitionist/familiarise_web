/**
 * Dispute Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-disputes.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { reconcileDisputes } from "@/scripts/disputes/reconcile-disputes";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-disputes",
  run: async () => {
    const result = await reconcileDisputes();
    // Alert on urgent disputes
    if (result.urgentCount > 0) {
      console.warn(
        `ALERT: ${result.urgentCount} disputes require immediate attention!`,
      );
    }
    return result;
  },
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    urgentCount: r.urgentCount,
    razorpayManualReviewCount: r.razorpayManualReviewCount,
  }),
  status: () => 200,
  failureMessage: "Failed to reconcile disputes",
});
