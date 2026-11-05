/**
 * `after()` that survives being reached outside a request scope.
 *
 * Next's `after()` throws when no request context is active — jest, scripts
 * (`scripts/payments/reconcile-orphaned-confirmations.ts` drives the webhook
 * handlers directly), and any lib path a cron twin reaches. Inside a route
 * or server action it schedules the task for the platform's `waitUntil`
 * (Netlify: full support, held until settled, billed as duration). Outside
 * one it degrades to a floating promise, which is what those callers ran
 * before. Never throws.
 *
 * The task's own rejection is REPORTED, not just logged. This wrapper used to
 * `console.error` and nothing else, which meant 12 of its 13 call sites
 * produced no Sentry event and no `system_events` row on failure — including
 * the referral bell and credits-applied bell in `handlePaymentSuccess`, the
 * invite emails in the org routes, and the bell staging in the verification
 * review door. A settled refund could therefore leave a payer with no receipt
 * and no trace of why. One `console.error` in a Netlify log nobody reads is
 * not an acceptable failure channel for money-path side effects.
 */

import { after } from "next/server.js";

import { reportSentryError } from "@/lib/observability/report";

/**
 * Name the task, so a failure names the operation that produced it rather
 * than an anonymous `[after] task failed`. Defaults to the wrapper's own
 * subsystem when a caller has nothing better.
 */
export function scheduleAfter(
  task: () => Promise<unknown> | unknown,
  op?: string,
): Promise<void> {
  const run = (): Promise<void> =>
    Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch((error) => {
        reportSentryError(error, {
          subsystem: "after",
          op: op ?? "scheduleAfter",
          level: "warning",
        });
      });
  try {
    after(run);
    return Promise.resolve();
  } catch {
    return run();
  }
}
