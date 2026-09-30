/**
 * B5 stuck-webhook sweeper API endpoint (#785, task #10).
 *
 * Thin wrapper around scripts/cleanup/sweep-stuck-webhook-events.ts. Re-drives
 * WebhookEvent rows left processed=false after an after()-callback crash.
 *
 * Schedule: every ~10 minutes (CRON_SECRET-gated, like the other cleanup jobs).
 */
import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { sweepStuckWebhookEvents } from "@/scripts/cleanup/sweep-stuck-webhook-events";

export const { GET, POST } = cleanupRoute({
  job: "sweep-stuck-webhook-events",
  run: (req) => sweepStuckWebhookEvents({ limit: parseLimitParam(req) }),
  // #1829 — `gaveUp` and `deferred` were both computed and neither reported.
  // `gaveUp` is the terminal outcome: the row is now `processed: true` with a
  // `gave up:` error and will never be touched again, which is the single event
  // class that most needs a human. On the Netlify ticker path — the one that
  // actually runs in production, since #1634 — the return body is all anybody
  // sees, so a permanently abandoned Stream event was invisible while this job
  // reported a clean 200.
  summarize: (r) => ({
    scanned: r.scanned,
    recovered: r.recovered,
    stillFailing: r.stillFailing,
    deferred: r.deferred,
    gaveUp: r.gaveUp,
  }),
  // 207 whenever any row is still failing OR was terminally given up on: both
  // mean the sweep did not leave the queue clean. `deferred` is deliberately
  // excluded — a deferral is a handler decision to retry later, not a fault, and
  // folding it in would make a healthy queue report 207 forever.
  status: (r) => (r.stillFailing > 0 || r.gaveUp > 0 ? 207 : 200),
  failureMessage: "Failed to sweep stuck webhook events",
});
