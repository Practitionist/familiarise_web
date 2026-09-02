/**
 * Payment Status Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-payment-status.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 30 minutes (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-payment-status",
  run: () => reconcilePaymentStatus(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    succeededCount: r.succeededCount,
    failedCount: r.failedCount,
  }),
  // Return 207 if succeeded payments found (needs attention)
  status: (r) => (r.succeededCount > 0 ? 207 : r.success ? 200 : 500),
  failureMessage: "Failed to reconcile payment status",
});
