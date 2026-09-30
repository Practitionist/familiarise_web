/**
 * Reschedule Proposal Expiry API Endpoint
 *
 * Thin wrapper around scripts/appointments/expire-reschedule-proposals.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron), plus the Netlify
 * ticker's 15-minute slot (#1583 P1).
 *
 * #1583 P1 — `?limit=` is now READ. The ticker's limit was being appended to
 * this URL and discarded, so each tick ran the core's full 4 × 500 batch loop
 * — a per-row transaction plus an appointment lock and a slot restore each,
 * against a 20 s abort.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { expireRescheduleProposals } from "@/scripts/appointments/expire-reschedule-proposals";

/**
 * Proposals per run. One appointment-lock acquisition, one transaction and up
 * to one restore notice per row, and the restore itself can lose to an overlap
 * and retry — so the per-row cost is high enough that a small bite is the
 * only thing that fits a 20 s budget. Resumable: EXPIRED leaves the cohort.
 */
const MAX_PROPOSALS_PER_RUN = 25;

export const { GET, POST } = cleanupRoute({
  job: "expire-reschedule-proposals",
  run: (req) =>
    expireRescheduleProposals({
      maxPerRun: parseLimitParamOrDefault(req, MAX_PROPOSALS_PER_RUN),
    }),
  summarize: (r) => ({
    proposalsExpired: r.proposalsExpired,
    proposalsExpiredUnrestored: r.proposalsExpiredUnrestored,
  }),
  failureMessage: "Failed to expire reschedule proposals",
});
