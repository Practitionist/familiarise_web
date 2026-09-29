/**
 * Retry Auto-Refunds API Endpoint (#1846 N2)
 *
 * Thin wrapper around scripts/payments/retry-auto-refunds.ts, the HTTP twin
 * the five-minute ticker calls every 15 minutes (ADR 27). A payment whose
 * attempt budget ran out answers 207 so the tick reads it as needing an
 * operator.
 */

import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import { retryAutoRefunds } from "@/scripts/payments/retry-auto-refunds";

export const { GET, POST } = cleanupRoute({
  job: "retry-auto-refunds",
  run: (req) => retryAutoRefunds({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    refunded: r.refunded,
    settled: r.settled,
    failed: r.failed,
    stuck: r.stuck,
    errors: r.errors,
  }),
  status: (r) => statusFor(r, r.stuck.length > 0),
  failureMessage: "Failed to retry auto-refunds",
});
