/**
 * Shared per-instance/per-minute Sentry throttle for "the same underlying
 * outage causes an unbounded capture per invocation" call sites — the
 * pattern `lib/rate-limit.ts`'s `applyRateLimit()` catch block introduced
 * under #1125: a Redis outage is total, not per-caller, so every capture
 * after the first in the window carries no new information, only quota
 * cost. #1822 — the same shape lived uncaught in `readMaintenancePhase()`
 * and the `cleanupRoute()` catch-all, which is what turned one Upstash cap
 * into ~4,000 Sentry events in ~25h. Extracted here so the throttle window
 * is shared code, not three copies that can drift.
 */

import { reportSentryError, type ReportOpts } from "@/lib/observability/report";

const DEFAULT_INTERVAL_MS = 60_000;

// Per-instance, keyed by caller-supplied string — one lastReportAt per key
// rather than one global timestamp, so an outage in one subsystem doesn't
// consume the throttle window another subsystem needs. Module scope is
// intentional (see #1125's note on rate-limit.ts): there is no shared state
// to coordinate through when the shared state IS what is down.
const lastReportAtByKey = new Map<string, number>();

/**
 * Report `error` via Sentry at most once per `key` per `intervalMs`
 * (default 60s). Returns true when a report was actually sent, so callers
 * that also need a one-shot log line can key off the same decision.
 */
export function captureThrottled(
  key: string,
  error: unknown,
  opts: ReportOpts,
  intervalMs = DEFAULT_INTERVAL_MS,
): boolean {
  const now = Date.now();
  const last = lastReportAtByKey.get(key) ?? 0;
  if (now - last <= intervalMs) return false;
  lastReportAtByKey.set(key, now);
  reportSentryError(error, opts);
  return true;
}

/** Test-only: clears the throttle windows between cases. */
export function resetThrottledCaptureForTesting(): void {
  lastReportAtByKey.clear();
}
