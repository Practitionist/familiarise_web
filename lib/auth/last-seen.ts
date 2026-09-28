import prisma from "@/lib/prisma";

/**
 * Throttled `Session.lastSeenAt` touch (#1856).
 *
 * Semantics, stated honestly because the UI renders this: `lastSeenAt`
 * is the last SERVER-VALIDATED activity for the session, accurate to
 * ~5 minutes. The 5-minute cookie cache means most requests never reach
 * the database, and BetterAuth's own `/get-session` (the `useSession`
 * poll) never passes through our code — so this is NOT true "last
 * active". The UI must say "Active in the last 5 minutes", never
 * "Active now".
 *
 * Two throttle layers, both required:
 * 1. In-process map (this file): at most one Prisma query per session
 *    per 5 min per lambda. Production runs `PG_POOL_MAX=1` — without
 *    this, a burst of touches would serialize on the single connection.
 * 2. SQL predicate (`lastSeenAt IS NULL OR < cutoff`): concurrent
 *    touches from N lambdas collapse into idempotent no-ops at the DB.
 *
 * Fire-and-forget by contract: returns void, never throws. Callers
 * invoke it WITHOUT await; a touch that loses the serverless-freeze
 * race or hits a blip simply delays the marker by one more request.
 * A missed touch is cosmetic, never auth-affecting — `updateMany`
 * cannot change which sessions validate.
 */
export const LAST_SEEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Bound: one entry per live session; FIFO-evicted, never unbounded. */
const LAST_SEEN_CACHE_LIMIT = 2000;

const lastTouchBySession = new Map<string, number>();

export function touchSessionLastSeen(sessionId: string): void {
  if (!sessionId) return;
  const now = Date.now();
  const last = lastTouchBySession.get(sessionId) ?? 0;
  if (now - last < LAST_SEEN_TOUCH_INTERVAL_MS) {
    // Refresh recency even on a throttled hit: Map.set on an existing
    // key does NOT move it, so without this the eviction below eats the
    // hottest sessions first under churn — the exact PG_POOL_MAX=1
    // pressure this cache exists to avoid. Re-insert with the OLD
    // timestamp (not now): moving the throttle window forward on every
    // throttled hit would defer the next write indefinitely under
    // constant traffic and freeze lastSeenAt.
    lastTouchBySession.delete(sessionId);
    lastTouchBySession.set(sessionId, last);
    return;
  }
  lastTouchBySession.set(sessionId, now);
  if (lastTouchBySession.size > LAST_SEEN_CACHE_LIMIT) {
    // Map preserves insertion order — deleting the first key evicts
    // the stalest entry. One eviction per insert keeps it amortized.
    const oldest = lastTouchBySession.keys().next();
    if (!oldest.done) lastTouchBySession.delete(oldest.value);
  }
  const cutoff = new Date(now - LAST_SEEN_TOUCH_INTERVAL_MS);
  void prisma.session
    .updateMany({
      where: {
        id: sessionId,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
      },
      data: { lastSeenAt: new Date() },
    })
    .catch(() => {
      // Best-effort: a failed touch must never surface. The marker is
      // re-attempted on the next request after the interval elapses.
    });
}

/** Test hook: reset the in-process throttle between cases. */
export function __resetLastSeenCacheForTests(): void {
  lastTouchBySession.clear();
}
