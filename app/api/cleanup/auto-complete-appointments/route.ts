/**
 * Auto-Complete Appointments API Endpoint
 *
 * Thin wrapper around scripts/auto-complete-appointments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly at :07 via GitHub Actions, plus the Netlify ticker's
 * 30-minute slot (#1775).
 *
 * #1775 — on the ticker. This job gates the earnings hold release and the
 * feedback window one hour after a session ends, and its only other driver is
 * a `cron:` schedule that ADR 22 measured delivering at ~100 minutes. The
 * ticker's `?limit=` is now READ, which it never was: the core took no
 * arguments, so all five parent passes ran unbounded inside a 20 s abort.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { autoCompleteAppointments } from "@/scripts/appointments/auto-complete-appointments";

/**
 * Parents per pass. A parent row costs a guarded CAS, a completion bell, and —
 * for subscriptions — an entitlement computation over every occurrence. The
 * slot pass below is separate and keeps its own figure, because it is the one
 * that makes a Stream call report per session.
 */
const MAX_PARENTS_PER_PASS = 25;
/** Past sessions judged this run; each may cost one Stream call report. */
const MAX_SLOT_OUTCOMES = 25;

export const { GET, POST } = cleanupRoute({
  job: "auto-complete-appointments",
  run: (req) => {
    const limit = parseLimitParamOrDefault(req, MAX_PARENTS_PER_PASS);
    return autoCompleteAppointments({
      maxParents: limit,
      maxSlotOutcomes: limit,
    });
  },
  summarize: (r) => ({
    webinarsCompleted: r.webinarsCompleted,
    classesCompleted: r.classesCompleted,
    consultationsCompleted: r.consultationsCompleted,
    subscriptionsCompleted: r.subscriptionsCompleted,
  }),
  failureMessage: "Failed to auto-complete appointments",
});
