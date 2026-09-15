/**
 * POST /api/cleanup/retry-failed-emails
 *
 * #1648 / #1654 — the Netlify ticker's twin of jobs/email/retry-failed-emails.ts:
 * the outbox relay that finishes every email the inline fast path left PENDING.
 * Gated by `CRON_SECRET` like every route under /api/cleanup; the worker's
 * cron lock keeps a tick that overlaps the GitHub Actions run from sending twice.
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { retryFailedEmails } from "@/jobs/email/retry-failed-emails";

export const { GET, POST } = cleanupRoute({
  job: "retry-failed-emails",
  // No disconnect — `prisma` is the shared Next runtime singleton; only the
  // standalone job wrapper disconnects.
  run: (req) => retryFailedEmails({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    sent: r.sent,
    retried: r.retried,
    deadLettered: r.deadLettered,
    errors: r.errors.length,
  }),
  status: (r) => (r.errors.length > 0 ? 500 : 200),
  unauthorizedMessage: "Provide a valid Bearer CRON_SECRET",
  failureMessage: "Email relay tick failed",
});
