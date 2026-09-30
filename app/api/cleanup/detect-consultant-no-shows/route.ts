/**
 * Consultant No-Show Detection API Endpoint (#1517)
 *
 * Thin wrapper around scripts/appointments/detect-consultant-no-shows.ts, the same
 * core the GitHub Actions job runs; gives the Netlify ticker and CRON_SECRET the
 * access every other cleanup twin has. It is a money job (FINANCIAL_JOB_NAMES).
 *
 * Schedule: hourly at :57 via GitHub Actions, plus the Netlify ticker's
 * 30-minute slot (#1775).
 *
 * #1775 — this job is ON the ticker now. The prior note here said it was not,
 * and pointed at the docs' "not latency-sensitive" line. That line does not
 * hold: the job's outcome is a 100% refund through the front door, its grace
 * window is measured in tens of minutes, and its only other driver is a `cron:`
 * schedule ADR 22 measured at ~100 minutes. The ticker's `?limit=` is also now
 * READ, which it never was — the cohort read had no `take` at all.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { detectConsultantNoShows } from "@/scripts/appointments/detect-consultant-no-shows";

/**
 * Candidates per run. Each one costs a Stream call-report corroboration before
 * any money moves, so the per-row cost is a vendor round trip; ten is what
 * fits the 20 s tier with room for the refund and the two bells that follow.
 */
const MAX_CANDIDATES_PER_RUN = 10;

export const { GET, POST } = cleanupRoute({
  job: "detect-consultant-no-shows",
  run: (req) =>
    detectConsultantNoShows({
      maxCandidates: parseLimitParamOrDefault(req, MAX_CANDIDATES_PER_RUN),
    }),
  summarize: (r) => ({
    detected: r.detected,
    refunded: r.refunded,
    contradicted: r.contradicted,
    bothAbsentTickets: r.bothAbsentTickets,
  }),
  failureMessage: "Failed to detect consultant no-shows",
});
