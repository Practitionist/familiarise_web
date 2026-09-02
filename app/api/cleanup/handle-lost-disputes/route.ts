/**
 * Lost Dispute Handler API Endpoint
 *
 * Thin wrapper around scripts/handle-lost-disputes.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #304
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { handleLostDisputes } from "@/scripts/disputes/handle-lost-disputes";

export const { GET, POST } = cleanupRoute({
  job: "handle-lost-disputes",
  run: () => handleLostDisputes(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    updatedCount: r.updatedCount,
    skippedCount: r.skippedCount,
    alreadyPaidCount: r.alreadyPaidCount,
    errorCount: r.errorCount,
  }),
  // Return appropriate status based on critical cases
  status: (r) => (r.alreadyPaidCount > 0 ? 207 : r.success ? 200 : 500),
  failureMessage: "Failed to handle lost disputes",
});
