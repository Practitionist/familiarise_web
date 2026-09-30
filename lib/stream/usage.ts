/**
 * Stream quota metering — issue #1134 E5.
 *
 * ## What was missing
 *
 * Until this file the repository contained no MAU counter, no participant-minute
 * counter, no concurrency estimate and no usage read of any kind. The only
 * record that Stream's pricing model exists at all was a sentence in a doc
 * telling a human to go and look. That is a bad posture for three reasons, and
 * they compound:
 *
 *  1. **Stream's Maker tier is a HARD PAUSE, not overage.** The caps are
 *     2,000 MAU (chat), 333,000 participant-minutes (video) and 125,000 feed API
 *     calls. Past any of them, the documented behaviour is that ADDITIONAL USERS
 *     CANNOT CONNECT. There is no bill to discover afterwards — the product
 *     simply stops working for new people, which is the failure that costs the
 *     most and is noticed the latest.
 *  2. **Video bills the AGGREGATED RECEIVED resolution**, and Stream states
 *     plainly that it cannot cap it. `default` is pinned to 720p in the call
 *     type, but an active gallery still drifts up a tier as participants join,
 *     so the per-minute cost per participant is not a constant we may assume.
 *  3. **Stream's own rate-limit surface is barely visible.** The app-level
 *     ceilings surfaced by the management API are chat-only (`QueryChannels`
 *     10,000/min, `SendMessage` 1,000/min, `UpdateChannelPartial` 300/min). The
 *     VIDEO ceilings are documented but not returned by that call at all, and
 *     the tightest of them is `GetOrCreateCall` at 1,000/min app-wide — about
 *     33/second — with a separate hard 60-requests/minute PER USER per endpoint
 *     on top. A burst of joins is the shape most likely to meet one of those,
 *     and the shape least visible from a chat-only table.
 *
 * So: alarm BEFORE the cap, from data we already hold, at a command cost the
 * Upstash budget can absorb.
 *
 * ## The three numbers, and where each comes from
 *
 *   MAU                    Redis. One marker write per token mint, plus a
 *                           counter bump the first time a given user is seen
 *                           inside a trailing 30-day window. This is the one
 *                           figure Stream bills that Postgres cannot answer: it
 *                           counts users who CONNECTED to Stream, not users
 *                           who signed in.
 *   Participant-minutes    Postgres. `MeetingAttendance` already stores
 *                           `firstJoinedAt` / `lastLeftAt` per (session,
 *                           participant), written by the participant webhooks.
 *                           A better source than anything Stream would sell us,
 *                           and it costs zero vendor calls.
 *   Peak concurrency        Postgres, estimated from the same intervals. Not
 *                           exact — see the estimator's own docblock.
 *
 * ## Upstash command cost — the whole design turns on this
 *
 * The 500k monthly cap has been hit twice (#1792 at 696k, #1822), production
 * and every deploy-preview share ONE database, and `.env.sample` records that
 * command COUNT is the budget rather than dollar spend. Anything added here is
 * justified against that number, so:
 *
 *   Token mint (`noteStreamTokenMint`)   1 command per mint in the steady state
 *                                        (a user already inside the window),
 *                                        3 the first time a user appears in it.
 *                                        Batched so it is ONE HTTP round trip,
 *                                        which saves latency but NOT quota —
 *                                        Upstash counts the commands inside a
 *                                        pipeline individually, and pretending
 *                                        otherwise would be the dishonest part
 *                                        of this file.
 *                                        At ~200 daily actives × ~6 session
 *                                        tokens each: ≈1,400 commands/day,
 *                                        ≈42,000/month, ≈8% of the free cap.
 *                                        Switch it off with
 *                                        `STREAM_USAGE_METER_ENABLED=false`;
 *                                        the Postgres-derived numbers keep
 *                                        working without it.
 *   Nightly meter (the writer below)       1 `HSET` + 1 `EXPIRE` per run. A
 *                                        daily schedule is 2/day, ~730/month —
 *                                        three orders of magnitude below the
 *                                        mint path, free in practice.
 *   `/api/health` read                     1 `HGETALL` + 1 `GET`, cached per
 *                                        instance for
 *                                        {@link STREAM_USAGE_HEALTH_CACHE_MS}.
 *                                        At BetterStack's three-minute cadence
 *                                        that is ~960/day, ~29,000/month (5.8%
 *                                        of the free cap); at a one-minute
 *                                        cadence, 8.6%. See the health route for
 *                                        why this reads a PRECOMPUTED snapshot
 *                                        rather than counting live.
 *
 * Total added: under 11% of the free cap, ~85% of it from the one number that
 * cannot be derived from data we already store. That is the trade being made,
 * written down so the next person can disagree with it.
 *
 * ## Why a snapshot, not a live count
 *
 * `/api/health` is polled by an external monitor. Computing MAU live on each
 * poll would mean a `SCAN` over the keyspace (Redis gives no `SCARD` across
 * per-user keys) plus a read of the `Session` table — unbounded work in an
 * endpoint whose job is to answer fast. So the nightly job writes ONE hash and
 * the health route reads that hash. The consequence is stated rather than
 * hidden: the participant-minute and concurrency figures can be up to 24 hours
 * stale, which is irrelevant against a monthly cap, whereas MAU comes from a
 * live counter and is exact to the last mint.
 */

import type { Redis } from "@upstash/redis";
import redisClient from "@/lib/redis";
import { captureThrottled } from "@/lib/observability/throttled-capture";

/**
 * The commands this module needs, and the one cast that admits it.
 *
 * `lib/redis` exports `Redis | MockRedis`, and MockRedis implements `set`,
 * `get`, `incr` and `expire` but not `hset` / `hgetall` — the two the nightly
 * snapshot needs. Union member access would therefore not compile, and a
 * structural interface parameter was rejected in favour of this because it
 * pushed a `as unknown as` onto every caller instead of onto one line that can
 * carry the reason. In production `redisClient` is the real `Redis`, so the cast
 * is a no-op; in a unit test, `jest.mock("@/lib/redis")` supplies whichever
 * subset the case needs.
 *
 * `set` is called with `px`, not `ex`, so the marker write is also valid against
 * MockRedis — the one command of the mint path that a mock-Redis test exercises
 * for real.
 */
type UsageRedis = Pick<
  Redis,
  "set" | "incr" | "expire" | "hset" | "hgetall" | "get"
>;
const redis = redisClient as unknown as UsageRedis;

/** Trailing window Stream bills MAU over. */
export const STREAM_MAU_WINDOW_DAYS = 30;
const MAU_WINDOW_SECONDS = STREAM_MAU_WINDOW_DAYS * 24 * 60 * 60;

/**
 * How long the running counter is kept after the last mint. Not 30 days: a
 * month is not 30 days, and a figure 6% short at the end of a 31-day month is a
 * figure that has stopped being a budget. 45 days covers the longest plausible
 * billing month and still self-cleans.
 */
const MAU_COUNTER_TTL_SECONDS = 45 * 24 * 60 * 60;

/** Per-instance cache for the health route's read. See the module docblock. */
export const STREAM_USAGE_HEALTH_CACHE_MS = 60_000;

/**
 * Stream's Maker-tier caps — the numbers this file exists to alarm on.
 *
 * Eligibility is documented as under 5 team members, under $100k raised and
 * under $10k MRR, which is this project's profile. Eligibility is a commercial
 * fact, not a technical one, and it can change with no code change here — so
 * these are treated as an UPPER BOUND on what we are actually sold. If Stream
 * moves the app to a paid tier the numbers go up and the alarms fall silent,
 * which is the correct outcome and the reason nothing here fails on a tier
 * change.
 *
 * Past a Maker cap "additional users cannot connect". That is why the thresholds
 * alarm EARLY: at the cap the product is already refusing new connections and
 * the number would be a post-mortem rather than a warning.
 */
export const STREAM_MAKER_LIMITS = {
  /** Monthly active users, chat. */
  mau: 2_000,
  /** Video participant-minutes per month, at the billed call quality. */
  participantMinutes: 333_000,
  /** Feed API calls per month. Not metered — see {@link STREAM_UNMETERED}. */
  feedApiCalls: 125_000,
} as const;

export type StreamUsageMeter = keyof typeof STREAM_MAKER_LIMITS;

/**
 * The levels that alarm. 60 is "plan the upgrade", 80 is "act this month", 90
 * is "you have weeks". All three are BELOW the cap rather than at it, because at
 * the cap the product is already refusing new connections.
 */
export const STREAM_USAGE_ALERT_THRESHOLDS = [0.6, 0.8, 0.9] as const;

/**
 * Metrics this module deliberately does NOT meter, and why that is a known gap
 * rather than an oversight.
 *
 * The feed-API-call cap (125,000/month) has no cheap source: counting it means
 * instrumenting every reaction and feed write, which is a change to the Chat
 * call sites rather than to a meter.
 *
 * The per-endpoint rate-limit ceilings — including the VIDEO ones the management
 * API does not return — are a different axis again. They are per MINUTE, so no
 * monthly meter can answer them, and the honest place to police them is the
 * pacing already in `lib/stream/batch.ts`.
 *
 * Recorded here so the next reader does not assume this file is complete
 * coverage of the plan.
 */
export const STREAM_UNMETERED: readonly StreamUsageMeter[] = ["feedApiCalls"];

const KEYS = {
  /** `stream:usage:mau:seen:<userId>` — the 30-day dedup marker. */
  mauSeen: (userId: string) => `stream:usage:mau:seen:${userId}`,
  /** `stream:usage:mau:count` — the running distinct-user count. */
  mauCount: "stream:usage:mau:count",
  /** `stream:usage:snapshot` — the nightly pre-computed figures. */
  snapshot: "stream:usage:snapshot",
} as const;

export interface StreamUsageSnapshot {
  /** Distinct users that minted a Stream token in the trailing 30 days. */
  mau: number;
  /**
   * Participant-minutes over the trailing 30 days, from `MeetingAttendance`.
   * An UPPER bound: a participant who joined and never left is counted to now.
   */
  participantMinutes: number;
  /** Highest estimated simultaneous participants over the window. */
  peakConcurrency: number;
  /** ISO timestamp of the run that produced this snapshot. */
  computedAt: string;
  /** True when the estimator hit its row cap and did NOT see everything. */
  estimated: boolean;
}

export interface StreamUsageMeterReading {
  used: number;
  cap: number;
  /** `used / cap`, 0 when the cap is unknown. */
  pct: number;
  /**
   * The HIGHEST crossed threshold, or null.
   *
   * Highest, not lowest: this is the level the alarm fires at and the level a
   * 3am alert should name ("we are past 80%"), and it is what makes each
   * escalation a distinct Sentry event rather than one event the 60% report
   * permanently suppresses. Both the number here and {@link worstAlert} are
   * monotone in usage, so a reader never has to work out which of two alert
   * numbers is the more urgent one.
   */
  alert: number | null;
}

export interface StreamUsageReport {
  /** null when nothing has been measured yet — "we do not know", not zero. */
  snapshot: StreamUsageSnapshot | null;
  /** Per-meter reading, or null for a meter with no data yet. */
  meters: Record<StreamUsageMeter, StreamUsageMeterReading | null>;
  /** The highest crossed threshold across all meters, or null. */
  worstAlert: number | null;
  /** Meters this module does not measure. */
  unmetered: readonly StreamUsageMeter[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Write side — the per-mint counter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the per-mint Redis counter runs at all.
 *
 * Default ON, because an unmeasured ceiling is worse than a bounded one, and the
 * escape hatch exists for the case where the operator has upgraded to
 * pay-as-you-go and decided 8% is not worth the MAU figure. Read on every call
 * rather than cached at module load so it can be flipped in the Netlify
 * environment without a rebuild of the call sites.
 */
function meterEnabled(): boolean {
  return process.env.STREAM_USAGE_METER_ENABLED !== "false";
}

/**
 * Record one Stream token mint against the trailing-30-day MAU window.
 *
 * Called from the CHAT token action only. Not from the video action: both mint
 * for the same user in the same session, so counting both would inflate MAU
 * twofold for no extra information, and Stream bills MAU per USER, not per
 * token.
 *
 * Cheap by construction — the three-command path is only paid by a user Stream
 * has not seen in 30 days:
 *
 *   1. `SET stream:usage:mau:seen:<userId> 1 NX PX 2592000000` — ONE command.
 *      The reply is `"OK"` for a user new to the window and `null` for one
 *      already counted, so the dedup decision and the marker write are the same
 *      round trip instead of a read followed by a write.
 *   2. Only on `"OK"`: `INCR`, then `EXPIRE` to keep the counter alive.
 *
 * Never throws, and the caller does not await it for a result. A quota meter
 * that can fail a login is strictly worse than no quota meter: a dropped
 * command shows up as a slightly low MAU rather than as a broken session, and
 * that is the right direction for a ceiling alarm. `await` is used INSIDE the
 * try rather than left floating on purpose: `@upstash/redis` returns a
 * thenable, so an un-awaited call here would be an unhandled rejection, which
 * is the one way a best-effort meter can still take a function down.
 */
export async function noteStreamTokenMint(userId: string): Promise<void> {
  if (!meterEnabled() || !userId) return;
  try {
    const claimed = await redis.set(KEYS.mauSeen(userId), "1", {
      nx: true,
      px: MAU_WINDOW_SECONDS * 1000,
    });
    // The mock returns the literal string and the real client the literal
    // "OK"; anything else means the claim did not happen, and guessing would
    // double-count a user — which is the only error direction that matters here.
    if (claimed !== "OK") return;
    await redis.incr(KEYS.mauCount);
    await redis.expire(KEYS.mauCount, MAU_COUNTER_TTL_SECONDS);
  } catch {
    // Swallowed on purpose — see the docblock above.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The read cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-instance cache so a chatty client polling `/api/health` cannot multiply
 * the two Redis commands {@link readStreamUsage} costs.
 *
 * Process-local on purpose, and the reasoning is the same as for the Sentry
 * infra throttle in `sentry.shared.config.ts`: the shared state here IS Redis,
 * and a cache that needed Redis to validate itself would fail exactly when the
 * number matters. A cold instance re-reads once, which is two commands.
 *
 * Longer than the data's own staleness needs to be: the participant-minute
 * figures are up to 24 h old anyway, so caching the READ for a minute costs no
 * freshness at all — except in the one minute after a nightly write, which
 * {@link writeStreamUsageSnapshot} handles by dropping this.
 *
 * Declared up here rather than beside `readStreamUsage` so the writer can reach
 * it without a use-before-define, and so the "one cache, one place to drop it"
 * shape is visible in one screen.
 */
let usageCache: { at: number; value: StreamUsageReport } | null = null;

/** Test-only: drops the read cache so a case can observe a fresh read. */
export function resetStreamUsageCacheForTesting(): void {
  usageCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write side — the nightly snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist the nightly snapshot. One `HSET` plus one `EXPIRE` — the entire
 * per-run Redis cost of the whole feature, and the reason the health route can
 * read a precomputed number instead of scanning.
 *
 * The TTL is 45 days so a monthly figure survives a missed night (a deploy
 * outage, an Actions throttle) and a human still has something to look at.
 */
export async function writeStreamUsageSnapshot(
  snapshot: StreamUsageSnapshot,
): Promise<void> {
  await redis.hset(KEYS.snapshot, {
    mau: String(snapshot.mau),
    participantMinutes: String(snapshot.participantMinutes),
    peakConcurrency: String(snapshot.peakConcurrency),
    computedAt: snapshot.computedAt,
    estimated: String(snapshot.estimated),
  });
  await redis.expire(KEYS.snapshot, MAU_COUNTER_TTL_SECONDS);
  // Drop the per-instance read cache. Without this, a `/api/health` poll that
  // landed in the minute before the nightly run would keep serving last night's
  // figures for up to a full cache window — on a MONTHLY budget, and on the one
  // endpoint whose whole job is to be current.
  usageCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read side
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the snapshot and fold it against the caps.
 *
 * This is the whole alarm: the nightly job decides whether to report and
 * `/api/health` decides whether to degrade, and neither re-derives the
 * arithmetic — so there is exactly one place where a cap is expressed.
 *
 * A read failure returns all-null rather than zeros. Zeros would read as "we
 * are nowhere near the cap", which is the most dangerous possible answer to
 * give a ceiling monitor.
 */
/**
 * Per-instance cache so a chatty client polling `/api/health` cannot multiply
 * the two Redis commands {@link readStreamUsage} costs.
 *
 * Process-local on purpose, and the reasoning is the same as for the Sentry
 * infra throttle in `sentry.shared.config.ts`: the shared state here IS Redis,
 * and a cache that needed Redis to validate itself would fail exactly when the
 * number matters. A cold instance re-reads once, which is two commands.
 *
 * Longer than the data's own staleness needs to be: the participant-minute
 * figures are up to 24 h old anyway, so caching the READ for a minute costs no
 * freshness at all.
 */
export async function readStreamUsage(): Promise<StreamUsageReport> {
  if (usageCache && Date.now() - usageCache.at < STREAM_USAGE_HEALTH_CACHE_MS) {
    return usageCache.value;
  }
  const value = await readStreamUsageUncached();
  usageCache = { at: Date.now(), value };
  return value;
}

async function readStreamUsageUncached(): Promise<StreamUsageReport> {
  const empty: StreamUsageReport = {
    snapshot: null,
    meters: { mau: null, participantMinutes: null, feedApiCalls: null },
    worstAlert: null,
    unmetered: STREAM_UNMETERED,
  };

  let hash: Record<string, string> | null = null;
  let liveMau: string | null = null;
  try {
    const [readHash, readMau] = await Promise.all([
      redis.hgetall<Record<string, string>>(KEYS.snapshot),
      redis.get<string>(KEYS.mauCount),
    ]);
    hash = readHash && typeof readHash === "object" ? readHash : null;
    liveMau = readMau ?? null;
  } catch {
    return empty;
  }

  const toNum = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  let snapshot: StreamUsageSnapshot | null = null;
  if (hash) {
    snapshot = {
      // The live counter wins over the snapshot's stored copy: it is exact to
      // the last mint, whereas the stored one is up to 24 h old. When the
      // counter has expired (45-day TTL) the stored figure is still better than
      // nothing, so it is the fallback rather than a zero.
      mau: liveMau === null ? toNum(hash.mau) : toNum(liveMau),
      participantMinutes: toNum(hash.participantMinutes),
      peakConcurrency: toNum(hash.peakConcurrency),
      computedAt: hash.computedAt ?? "",
      estimated: hash.estimated === "true",
    };
  } else if (liveMau !== null) {
    // The nightly job has never run, but mints are being counted. Reporting a
    // bare MAU beats reporting nothing: it is the number the chat cap is
    // measured in, and it is exact. `estimated: true` says the other two axes
    // are absent rather than zero.
    snapshot = {
      mau: toNum(liveMau),
      participantMinutes: 0,
      peakConcurrency: 0,
      computedAt: "",
      estimated: true,
    };
  }

  if (!snapshot) return empty;

  const meters: StreamUsageReport["meters"] = {
    mau: null,
    participantMinutes: null,
    feedApiCalls: null,
  };
  let worstAlert: number | null = null;

  const fold = (used: number, cap: number): StreamUsageMeterReading => {
    const pct = cap > 0 ? used / cap : 0;
    const crossed = STREAM_USAGE_ALERT_THRESHOLDS.filter((t) => pct >= t);
    const alert = crossed.length ? crossed[crossed.length - 1] : null;
    if (alert !== null && (worstAlert === null || alert > worstAlert)) {
      worstAlert = alert;
    }
    return { used, cap, pct, alert };
  };

  meters.mau = fold(snapshot.mau, STREAM_MAKER_LIMITS.mau);
  meters.participantMinutes = fold(
    snapshot.participantMinutes,
    STREAM_MAKER_LIMITS.participantMinutes,
  );

  return { snapshot, meters, worstAlert, unmetered: STREAM_UNMETERED };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alarm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Report the crossed threshold to Sentry, at most one event per LEVEL per
 * window.
 *
 * Throttled, and the throttle key includes the LEVEL, because the useful
 * transition is 60 → 80 → 90: a monthly budget that crosses 60% and then sits
 * there for three weeks should be one warning, not one per night. Each
 * escalation is its own key, so an escalation is never swallowed by the
 * threshold below it.
 */
export function alertStreamUsage(report: StreamUsageReport): void {
  if (report.worstAlert === null || !report.snapshot) return;
  const parts = Object.entries(report.meters)
    .filter(([, v]) => v !== null)
    .map(
      ([name, v]) =>
        `${name} ${v!.used}/${v!.cap} (${(v!.pct * 100).toFixed(1)}%)`,
    )
    .join(", ");
  captureThrottled(
    `stream-usage:${report.worstAlert}`,
    new Error(
      `Stream quota at ${(report.worstAlert * 100).toFixed(0)}% of the Maker cap: ${parts}. ` +
        "Past a Maker cap additional users cannot connect — it is a hard pause, " +
        "not overage — so the upgrade has to happen before this number, not after it.",
    ),
    {
      subsystem: "stream",
      op: "usage.alert",
      level: report.worstAlert >= 0.8 ? "error" : "warning",
      tags: { reason: "stream.usage_threshold" },
    },
  );
}
