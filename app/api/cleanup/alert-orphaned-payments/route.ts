/**
 * Orphaned Payments Alert API Endpoint
 *
 * Thin wrapper around scripts/alert-orphaned-payments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { alertOrphanedPayments } from "@/scripts/alerts/alert-orphaned-payments";

export const { GET, POST } = cleanupRoute({
  job: "alert-orphaned-payments",
  run: () => alertOrphanedPayments(),
  summarize: (r) => ({
    totalOrphaned: r.totalOrphaned,
    criticalCount: r.criticalCount,
    totalAmount: r.totalAmount,
  }),
  // #1846 — 500 on a detection, as before. This route already had the honest
  // status mapping; what it did NOT have was a durable trail behind the 500 and
  // an honest `success` flag on the result (the core returned `success: true`
  // with `criticalCount > 0`, so the Actions wrapper's exit code and the
  // SystemJobExecution row both read as healthy). Both are fixed in the core,
  // which now files one deduped SystemEvent per payment and reports to Sentry.
  status: (r) => (r.totalOrphaned > 0 ? 500 : 200),
  failureMessage: "Failed to check for orphaned payments",
});
