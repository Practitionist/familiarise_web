/**
 * Payment Status Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-payment-status.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 30 minutes (via GitHub Actions or external cron)
 */

import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-payment-status",
  run: (req) => reconcilePaymentStatus({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    succeededCount: r.succeededCount,
    failedCount: r.failedCount,
    unresolvableCount: r.unresolvableCount,
    retiredCount: r.retiredCount,
  }),
  // 207 when succeeded payments were reconciled, or when a pending row carries
  // an id the gateway does not know (#1708) or was retired for it (#1757) —
  // attention, not failure; 500 stays reserved for a gateway outage.
  status: (r) =>
    statusFor(
      r,
      r.succeededCount > 0 || r.unresolvableCount > 0 || r.retiredCount > 0,
    ),
  failureMessage: "Failed to reconcile payment status",
});
