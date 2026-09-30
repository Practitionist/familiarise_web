/**
 * Unpaid Trial Expiry API Endpoint
 *
 * Thin wrapper around scripts/trials/expire-unpaid-trials.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * The GitHub Action (jobs/trials/expire-unpaid-trials.ts) runs hourly and the
 * Netlify ticker POSTs this twin every 15 minutes (#1583 E-P0-04); both share
 * the cron lock held in the core, so the loser answers 409.
 *
 * #1583 P1 — `?limit=` is now READ. The ticker's limit was appended and
 * discarded, so each tick ran the core's full 4 × 500 batch loop plus the
 * 48-hour unanswered arm with its per-payment refund, against a 6 s abort.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { expireUnpaidTrials } from "@/scripts/trials/expire-unpaid-trials";

/**
 * Trials per run. Arm (i) is a guarded transition, a tombstone and a bell;
 * arm (ii) adds a full gateway refund per payment. CANCELLED leaves both
 * cohorts and the refund is keyed, so a capped run continues next tick.
 */
const MAX_TRIALS_PER_RUN = 25;

export const { GET, POST } = cleanupRoute({
  job: "expire-unpaid-trials",
  run: (req) =>
    expireUnpaidTrials({
      maxTrials: parseLimitParamOrDefault(req, MAX_TRIALS_PER_RUN),
    }),
  summarize: (r) => ({ trialsExpired: r.trialsExpired }),
  failureMessage: "Failed to expire unpaid trial sessions",
});
