/**
 * Release Earnings API Endpoint
 *
 * Thin wrapper around scripts/release-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

export const { GET, POST } = cleanupRoute({
  job: "release-earnings",
  run: (req) => releaseEarningsFromHold({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    releasedCount: r.releasedCount,
    errorCount: r.errorCount,
  }),
  status: () => 200,
  failureMessage: "Failed to release earnings",
});
