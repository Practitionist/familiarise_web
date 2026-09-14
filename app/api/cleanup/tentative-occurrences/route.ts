/**
 * Tentative Slot Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-tentative-occurrences.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 2 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupTentativeOccurrences } from "@/scripts/appointments/cleanup-tentative-occurrences";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-tentative-occurrences",
  run: () => cleanupTentativeOccurrences(),
  summarize: (r) => ({
    slotsReleased: r.slotsReleased,
    appointmentsAffected: r.appointmentsAffected,
  }),
  failureMessage: "Failed to cleanup tentative slots",
});
