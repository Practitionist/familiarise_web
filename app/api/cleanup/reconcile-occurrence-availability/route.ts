/**
 * Slot Availability Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-occurrence-availability.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { reconcileOccurrenceAvailability } from "@/scripts/appointments/reconcile-occurrence-availability";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-occurrence-availability",
  run: () => reconcileOccurrenceAvailability(),
  summarize: (r) => ({
    tentativeFlagsCleared: r.tentativeFlagsCleared,
    doubleBookingsDetected: r.doubleBookingsDetected,
    // #1206 — sessions the top-up pass recovered for partially-scheduled plans.
    topUpsPlaced: r.topUps.placed,
    topUpSessionsPlaced: r.topUps.sessionsPlaced,
  }),
  // 207 when double bookings were detected and the run itself was clean.
  status: (r) => statusFor(r, r.doubleBookingsDetected > 0),
  failureMessage: "Failed to reconcile slot availability",
});
