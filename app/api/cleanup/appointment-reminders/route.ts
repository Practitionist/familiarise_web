/**
 * Appointment Reminders API Endpoint
 *
 * Thin wrapper around scripts/send-appointment-reminders.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 *
 * #1583 P1 — `?limit=` is now READ, and this is the route where it mattered
 * most: the ticker's limit was appended to the URL and discarded, so the core
 * ran an UNBOUNDED cohort read (no `take`, no `orderBy` at all) inside a 20 s
 * abort. The core also had no per-run ceiling of its own, so a GitHub Actions
 * run was equally unbounded.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { sendAppointmentReminders } from "@/scripts/appointments/send-appointment-reminders";

/**
 * Sessions per window per run.
 *
 * A row costs a Redis claim, a Novu trigger, a recipient-preference read, a
 * React render and a Resend call, so this is a budget in seconds and not a
 * preference. The core warns (`appointment_reminders_window_capped`) when a
 * window returns a full batch, because the 1h window is only 30 minutes wide
 * against a 15-minute tick: past this cap, the tail of a burst loses its 1h
 * reminder, and that is worth knowing about rather than inferring from a
 * count.
 */
const MAX_SESSIONS_PER_WINDOW = 25;

export const { GET, POST } = cleanupRoute({
  job: "appointment-reminders",
  run: (req) =>
    sendAppointmentReminders({
      maxPerWindow: parseLimitParamOrDefault(req, MAX_SESSIONS_PER_WINDOW),
    }),
  summarize: (r) => ({
    reminders24h: r.reminders24h,
    reminders1h: r.reminders1h,
  }),
  failureMessage: "Failed to send appointment reminders",
});
