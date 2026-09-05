/**
 * Orphaned-confirmation reconcile API endpoint.
 *
 * Thin wrapper around scripts/payments/reconcile-orphaned-confirmations.ts,
 * matching the GitHub Actions job in jobs/payments. Two passes run per
 * invocation: the #830 re-drive of a confirmation that never landed, and the
 * #1356 re-drive of the chat channel a capture failed to create.
 *
 * `?limit=` exists because a Netlify ticker calls this route on a short
 * schedule and cannot spend a function's whole budget on one sweep. It bounds
 * both passes, so a small value means "take a small bite of each backlog"
 * rather than starving one of them. It can only lower the channel pass: that
 * pass keeps its own ceiling in appointments and in buyer-level Stream calls,
 * because one appointment can carry hundreds of buyers. #1391
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { reconcileOrphanedConfirmations } from "@/scripts/payments/reconcile-orphaned-confirmations";

/** Upper bound on `?limit=`; above this the run cannot finish in one function. */
const MAX_LIMIT = 500;

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    // A malformed bound falls back to the script's defaults rather than
    // failing the run: this is a cron entry point, and refusing to sweep is a
    // worse outcome than sweeping the default number of rows.
    console.warn(
      `reconcile-orphaned-confirmations: ignoring invalid limit "${raw}"`,
    );
    return undefined;
  }
  return parsed;
}

export const { GET, POST } = cleanupRoute({
  job: "reconcile-orphaned-confirmations",
  run: (req) => {
    const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
    return reconcileOrphanedConfirmations(limit === undefined ? {} : { limit });
  },
  summarize: (r) => ({
    scanned: r.scanned,
    confirmed: r.confirmed,
    stillBlocked: r.stillBlocked,
    channelsEnsured: r.channelsEnsured,
    channelsFailed: r.channelsFailed,
    channelBuyerOps: r.channelBuyerOps,
    channelsDeferred: r.channelsDeferred,
  }),
  // A channel this run could not create is a buyer with no conversation, which
  // an operator has to see; the next run retries it, so it is not a failure.
  status: (r) => statusFor(r, r.channelsFailed > 0),
  failureMessage: "Failed to reconcile orphaned confirmations",
});
