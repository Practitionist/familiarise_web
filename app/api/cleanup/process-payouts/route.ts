/**
 * Process Payouts API Endpoint
 *
 * FIX #620: Uses canonical lib/payments/payouts service (with distributed locking
 * and atomic transactions) instead of scripts/payouts which lacks those safety features.
 *
 * Schedule: Weekly on Mondays at 9:00 PM UTC (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import {
  processApprovedPayouts,
  REQUEST_PAYOUT_RUN_BOUNDS,
} from "@/lib/payments/payouts";

export const { GET, POST } = cleanupRoute({
  job: "process-payouts",
  run: async () => {
    // #1846 N6 — bounded like every request-path run; the GitHub Actions job
    // (jobs/payouts/process-payouts.ts) is the unbounded scheduled run.
    const results = await processApprovedPayouts(REQUEST_PAYOUT_RUN_BOUNDS);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    return {
      success: failed === 0,
      processed: results.length,
      succeeded,
      failed,
      results,
    };
  },
  summarize: (r) => ({
    succeeded: r.succeeded,
    failed: r.failed,
    processed: r.processed,
  }),
  // #1390 review — the constant 200 masked a caught job error (success:false)
  // as healthy; the default statusFor already reads result.success.
  failureMessage: "Failed to process payouts",
});
