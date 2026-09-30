/**
 * Booking Consistency Reconcile API Endpoint
 *
 * Thin wrapper around scripts/reconcile/reconcile-booking-consistency.ts, the
 * same core the GitHub Actions job runs. Gives the ticker and any
 * CRON_SECRET-bearing operator the same access every other cleanup twin has.
 *
 * #1846 — deliberately NOT a ticker target. The job is a DETECTOR, so its
 * cadence is a cost (one Redis maintenance read, one lock acquire, one
 * heartbeat per run) and not a latency someone is waiting on. The nightly
 * Actions schedule is the driver, and the Actions twin stays the backstop for
 * the ticker-driven sweeps.
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { reconcileBookingConsistency } from "@/scripts/reconcile/reconcile-booking-consistency";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-booking-consistency",
  run: () => reconcileBookingConsistency(),
  summarize: (r) => ({
    paymentsChecked: r.paymentsChecked,
    paidWithoutLiveSeat: r.paidWithoutLiveSeat,
    newlyRecorded: r.newlyRecorded,
  }),
  // 207 when the detector ran clean and found something. Not 500: the run did
  // its job, and `reconcile-occurrence-availability` established the precedent
  // that a finding must not read as a fault or the job stops being trusted.
  status: (r) => statusFor(r, r.paidWithoutLiveSeat > 0),
  failureMessage: "Failed to reconcile booking consistency",
});
