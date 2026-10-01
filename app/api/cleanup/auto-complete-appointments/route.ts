/**
 * Auto-Complete Appointments API Endpoint
 *
 * Thin wrapper around scripts/auto-complete-appointments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly at :07 via GitHub Actions, plus the Netlify ticker's
 * 30-minute slot (#1775), which passes `?limit=` to cap each pass.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { autoCompleteAppointments } from "@/scripts/appointments/auto-complete-appointments";

/** Default cap for each parent pass and for the slot pass (one Stream report each). */
const MAX_PER_PASS = 25;

export const { GET, POST } = cleanupRoute({
  job: "auto-complete-appointments",
  run: (req) => {
    const limit = parseLimitParamOrDefault(req, MAX_PER_PASS);
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
