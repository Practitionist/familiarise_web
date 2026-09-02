/**
 * Payment-Earning Sync API Endpoint
 *
 * Thin wrapper around scripts/sync-payment-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #303
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";

export const { GET, POST } = cleanupRoute({
  job: "sync-payment-earnings",
  run: () => syncPaymentEarnings(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    createdCount: r.createdCount,
    skippedCount: r.skippedCount,
    errorCount: r.errorCount,
  }),
  status: () => 200,
  failureMessage: "Failed to sync payment earnings",
});
