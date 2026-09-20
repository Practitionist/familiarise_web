/**
 * `after()` that survives being reached outside a request scope.
 *
 * Next's `after()` throws when no request context is active — jest, scripts
 * (`scripts/payments/reconcile-orphaned-confirmations.ts` drives the webhook
 * handlers directly), and any lib path a cron twin reaches. Inside a route
 * or server action it schedules the task for the platform's `waitUntil`
 * (Netlify: full support, held until settled, billed as duration). Outside
 * one it degrades to a floating promise, which is what those callers ran
 * before. Never throws; the task's own rejection is logged.
 */

import { after } from "next/server";

export function scheduleAfter(task: () => Promise<unknown> | unknown): void {
  const run = () =>
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error("[after] task failed:", error);
      });
  try {
    after(run);
  } catch {
    void run();
  }
}
