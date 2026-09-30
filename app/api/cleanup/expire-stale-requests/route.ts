/**
 * Stale Request Expiration API Endpoint
 *
 * Thin wrapper around scripts/appointments/expire-stale-requests.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron), plus the Netlify
 * ticker's 15-minute slot (#1583 P1).
 *
 * #1583 P1 — `?limit=` is now READ. The ticker's default of 50 was being
 * appended to this URL and thrown away, because the core took no arguments, so
 * every tick ran all seven cohort arms at their Actions-sized caps — 3,500
 * rows and a possible gateway refund per expired payment, against a 20 s abort.
 * The default below is the floor for EVERY caller, not just the ticker.
 */

import {
  cleanupRoute,
  parseLimitParamOrDefault,
} from "@/lib/cron/cleanup-route";
import { expireStaleRequests } from "@/scripts/appointments/expire-stale-requests";

/**
 * Rows ONE cohort arm may touch per run.
 *
 * Deliberately small relative to the core's own 500: the seven arms run
 * sequentially under one lock, and the refund arm makes a gateway round trip
 * per payment, so the per-arm figure has to leave room for the run rather than
 * fit it alone.
 */
const MAX_REQUESTS_PER_RUN = 20;
/** Slot rows the stale-RESCHEDULED arm may release; a pure row-lock pass. */
const MAX_SLOT_RELEASES_PER_RUN = 200;

export const { GET, POST } = cleanupRoute({
  job: "expire-stale-requests",
  run: (req) =>
    expireStaleRequests({
      limits: {
        maxRequests: parseLimitParamOrDefault(req, MAX_REQUESTS_PER_RUN),
        maxSlotReleases: MAX_SLOT_RELEASES_PER_RUN,
      },
    }),
  summarize: (r) => ({
    consultationsExpired: r.consultationsExpired,
    subscriptionsExpired: r.subscriptionsExpired,
    subscriptionNudgesSent: r.subscriptionNudgesSent,
    paymentPendingExpired: r.paymentPendingExpired,
  }),
  failureMessage: "Failed to expire stale requests",
});
