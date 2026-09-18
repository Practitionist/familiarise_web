/**
 * Verification Housekeeping API Endpoint
 *
 * Thin wrapper around scripts/cleanup/sweep-verification.ts: unlinked uploads
 * older than 7 days, day-7 NEEDS_INFO reminders, day-14 stale closes.
 *
 * Schedule: Daily (via GitHub Actions or external cron)
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { sweepVerification } from "@/scripts/cleanup/sweep-verification";

export const { GET, POST } = cleanupRoute({
  job: "sweep-verification",
  run: () => sweepVerification(),
  summarize: (r) => ({
    unlinkedDeleted: r.unlinkedDeleted,
    remindersSent: r.remindersSent,
    staleClosed: r.staleClosed,
    errors: r.errors.length,
  }),
  status: (r) => statusFor(r, r.errors.length > 0),
  failureMessage: "Failed to sweep verification",
});
