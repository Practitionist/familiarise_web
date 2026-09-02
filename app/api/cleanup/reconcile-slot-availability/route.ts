/**
 * Slot Availability Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-slot-availability.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { reconcileSlotAvailability } from "@/scripts/appointments/reconcile-slot-availability";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-slot-availability",
  run: () => reconcileSlotAvailability(),
  summarize: (r) => ({
    tentativeFlagsCleared: r.tentativeFlagsCleared,
    doubleBookingsDetected: r.doubleBookingsDetected,
  }),
  // Return 207 if double bookings detected (needs attention); 500 on errors.
  status: (r) => (r.doubleBookingsDetected > 0 ? 207 : r.success ? 200 : 500),
  failureMessage: "Failed to reconcile slot availability",
});
