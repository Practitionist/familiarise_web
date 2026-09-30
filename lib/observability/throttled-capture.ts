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

/**
 * Hard ceiling on distinct throttle keys held per instance.
 *
 * The map was unbounded and keyed on a CALLER-SUPPLIED STRING, which is the
 * combination that turns a throttle into a leak: every distinct key is retained
 * for the life of the process, and nothing ever removes one. A key that embeds
 * an id — which several call sites do, e.g.
 * `check-cron-heartbeat.ts`'s probe key and anything shaped like
 * `stream-health:webhook-secret:<reason>` — is then a keyspace proportional to
 * the number of distinct values, not to the number of distinct failure CLASSES.
 * The throttle is supposed to collapse repeats of one underlying fact; an
 * unbounded map lets it silently become a per-id firehose instead, which is the
 * flood the whole module exists to prevent.
 *
 * On a serverless instance the leak is bounded by the reclaim (~5 min idle) and
 * is therefore mostly harmless. It is still fixed, because (a) the cron entry
 * points run in a LONG-LIVED Node process — `runJobWithSentry` wraps a bare
 * `tsx` job that can run for 35 minutes against the 100k-user walk — so this is
 * a real unbounded map there, not a theoretical one, and (b) "mostly harmless
 * here" is exactly how the next caller ends up using it in a worker.
 *
 * 512 is far above the real number of classes in this codebase (double digits)
 * and far below anything that would matter for memory. Eviction is oldest-first
 * on INSERT rather than on read, which means an over-full map drops its oldest
 * key — and the oldest key is the one whose window has most likely already
 * expired, so a later report of that class re-fires once. That is the correct
 * failure direction: a duplicate event, not a lost one.
 */
const MAX_THROTTLE_KEYS = 512;

// Per-instance, keyed by caller-supplied string — one lastReportAt per key
// rather than one global timestamp, so an outage in one subsystem doesn't
// consume the throttle window another subsystem needs. Module scope is
// intentional (see #1125's note on rate-limit.ts): there is no shared state
// to coordinate through when the shared state IS what is down.
//
// Map preserves insertion order, which is what makes the eviction below a
// straightforward oldest-first sweep.
const lastReportAtByKey = new Map<string, number>();

function remember(key: string, now: number): void {
  if (
    lastReportAtByKey.size >= MAX_THROTTLE_KEYS &&
    !lastReportAtByKey.has(key)
  ) {
    const oldest = lastReportAtByKey.keys().next();
    if (!oldest.done) lastReportAtByKey.delete(oldest.value);
  }
  // #1829 — delete before setting. `Map.set` on a key that is ALREADY present
  // keeps that key's original insertion position, so a key reported on every
  // poll sat permanently at the front of the map and was the one the eviction
  // above removed next. The throttle therefore protected the quiet keys and
  // sacrificed the loudest one — the exact inverse of what it is for, and
  // invisible because the map still stayed under its cap.
  //
  // Delete-then-set makes the map an LRU ordered by last report, which is what
  // "evict the oldest" has to mean for the claim to be true.
  lastReportAtByKey.delete(key);
  lastReportAtByKey.set(key, now);
}

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
  remember(key, now);
  reportSentryError(error, opts);
  return true;
}

/**
 * Throttle window state for one key — `null` when nothing has been reported
 * under it. Exported so the bound is assertable from a test rather than being a
 * number in a comment that nothing checks; an unbounded map grows exactly as
 * slowly as its test suite, which is to say not at all.
 */
export function throttleKeyCountForTesting(): number {
  return lastReportAtByKey.size;
}

/** Test-only: clears the throttle windows between cases. */
export function resetThrottledCaptureForTesting(): void {
  lastReportAtByKey.clear();
}
