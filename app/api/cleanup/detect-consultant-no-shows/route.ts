/**
 * Consultant No-Show Detection API Endpoint (#1517)
 *
 * Thin wrapper around scripts/appointments/detect-consultant-no-shows.ts, the same
 * core the GitHub Actions job runs; gives the Netlify ticker and CRON_SECRET the
 * access every other cleanup twin has. It is a money job (FINANCIAL_JOB_NAMES).
 *
 * Schedule: hourly via GitHub Actions; not on the five-minute ticker (see docs/maintenance/04-cron-jobs-reference.md)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { detectConsultantNoShows } from "@/scripts/appointments/detect-consultant-no-shows";

export const { GET, POST } = cleanupRoute({
  job: "detect-consultant-no-shows",
  run: () => detectConsultantNoShows(),
  summarize: (r) => ({
    detected: r.detected,
    refunded: r.refunded,
    contradicted: r.contradicted,
    bothAbsentTickets: r.bothAbsentTickets,
  }),
  failureMessage: "Failed to detect consultant no-shows",
});
