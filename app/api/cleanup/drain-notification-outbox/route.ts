/**
 * POST /api/cleanup/drain-notification-outbox
 *
 * #1654 — the Netlify ticker's twin of jobs/notifications/drain-notification-outbox.ts:
 * the relay that finishes every Novu trigger the inline attempt left PENDING.
 * Gated by `CRON_SECRET` like every route under /api/cleanup; the cron lock
 * keeps two overlapping ticks from triggering a row twice.
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { drainNotificationOutbox } from "@/jobs/notifications/drain-notification-outbox";

export const { GET, POST } = cleanupRoute({
  job: "drain-notification-outbox",
  // No disconnect — `prisma` is the shared Next runtime singleton; only the
  // standalone job wrapper disconnects.
  run: (req) => drainNotificationOutbox({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    sent: r.sent,
    retried: r.retried,
    deadLettered: r.deadLettered,
    errors: r.errors.length,
  }),
  status: (r) => (r.errors.length > 0 ? 500 : 200),
  unauthorizedMessage: "Provide a valid Bearer CRON_SECRET",
  failureMessage: "Notification outbox drain failed",
});
