/**
 * Unpaid Trial Expiry API Endpoint
 *
 * Thin wrapper around scripts/trials/expire-unpaid-trials.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * The GitHub Action (jobs/trials/expire-unpaid-trials.ts) runs hourly and the
 * Netlify ticker POSTs this twin every 15 minutes (#1583 E-P0-04); both share
 * the cron lock held in the core, so the loser answers 409.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { expireUnpaidTrials } from "@/scripts/trials/expire-unpaid-trials";

export const { GET, POST } = cleanupRoute({
  job: "expire-unpaid-trials",
  run: () => expireUnpaidTrials(),
  summarize: (r) => ({ trialsExpired: r.trialsExpired }),
  failureMessage: "Failed to expire unpaid trial sessions",
});
