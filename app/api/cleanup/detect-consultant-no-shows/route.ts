/**
 * Consultant No-Show Detection API Endpoint (#1517)
 *
 * Thin wrapper around scripts/appointments/detect-consultant-no-shows.ts, the
 * same core the GitHub Actions job (jobs/appointments/detect-consultant-no-shows.ts)
 * runs. Gives the Netlify ticker / CRON_SECRET the same access every other
 * cleanup twin has (#1459's `?limit=` parsing was never wired here, and it is
 * a money job — see FINANCIAL_JOB_NAMES in lib/maintenance-cron.ts).
 *
 * Schedule: hourly via GitHub Actions; not on the five-minute Netlify ticker
 * yet (see docs/maintenance/04-cron-jobs-reference.md).
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
