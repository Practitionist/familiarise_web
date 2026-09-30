/**
 * Tentative Slot Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-tentative-occurrences.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 2 hours (via GitHub Actions or external cron)
 *
 * #1583 P1 — `?limit=` is now READ. The ticker's limit was appended and
 * discarded, so every tick ran the core's 5,000-row cap — the largest cohort
 * in the fleet — against a 6 s abort. The read carries a four-way OR over four
 * relations per row, so it is one of the more expensive reads here.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { cleanupTentativeOccurrences } from "@/scripts/appointments/cleanup-tentative-occurrences";

/**
 * Slots per run. The release is a chunked soft cancel rather than a per-row
 * transaction, so the per-row cost is low, but the cohort read is not — hence
 * well under the Actions cap. Resumable: the write stamps `deletedAt`, which
 * takes the row out of the cohort the next read collects.
 */
const MAX_SLOTS_PER_RUN = 200;

export const { GET, POST } = cleanupRoute({
  job: "cleanup-tentative-occurrences",
  run: (req) =>
    cleanupTentativeOccurrences({
      maxPerRun: parseLimitParamOrDefault(req, MAX_SLOTS_PER_RUN),
    }),
  summarize: (r) => ({
    slotsReleased: r.slotsReleased,
    appointmentsAffected: r.appointmentsAffected,
  }),
  failureMessage: "Failed to cleanup tentative slots",
});
