import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { measureEventLoopStall, probeWithStallRetry } from "@/lib/health/probe";
import { getMaintenanceState } from "@/lib/maintenance";
import { getStreamStatus } from "@/lib/stream/health";
import { getStreamCircuitStatus } from "@/lib/stream-client";
import { readStreamUsage } from "@/lib/stream/usage";
import prisma from "@/lib/prisma";
import redis, { isMockRedis, isRedisCircuitOpen } from "@/lib/redis";

type BetterStackHealth = {
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
};

const BETTERSTACK_CACHE_TTL_MS = 60_000;
// Module-level cache: instance-local in serverless (each cold start resets).
// Acceptable here — just prevents redundant BetterStack API calls within a warm instance.
let betterStackCache: { at: number; value: BetterStackHealth } | null = null;

async function checkBetterStack(): Promise<{
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
}> {
  const now = Date.now();
  if (
    betterStackCache &&
    now - betterStackCache.at < BETTERSTACK_CACHE_TTL_MS
  ) {
    return betterStackCache.value;
  }

  const apiKey = process.env.BETTERSTACK_API_KEY;
  if (!apiKey) {
    const value = { configured: false, reachable: null };
    betterStackCache = { at: now, value };
    return value;
  }

  try {
    const res = await fetch("https://uptime.betterstack.com/api/v2/monitors", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const value = { configured: true, reachable: false };
      betterStackCache = { at: now, value };
      return value;
    }

    const data = await res.json();
    const monitors = (data?.data ?? []).map(
      (m: { attributes: { url: string; status: string } }) => ({
        name: m.attributes.url,
        status: m.attributes.status,
      }),
    );

    const value = { configured: true, reachable: true, monitors };
    betterStackCache = { at: now, value };
    return value;
  } catch {
    const value = { configured: true, reachable: false };
    betterStackCache = { at: now, value };
    return value;
  }
}

// #1169/#866 — cron dead-man threshold. Every locked job run refreshes
// `cron:heartbeat:last` (lib/cron/with-cron-lock.ts); the dispatcher is
// scheduled every minute and GitHub's throttling delivers it at worst about
// every 2.75h measured, so >6h of total silence means the scheduled fleet has
// stopped — the failure the Actions-API heartbeat cannot report about itself.
const CRON_HEARTBEAT_STALE_MS = 6 * 60 * 60 * 1000;

type CronHeartbeat = {
  configured: boolean;
  lastRunAt: string | null;
  /**
   * `null` until the fleet has written its first heartbeat, or when the stored
   * timestamp will not parse. `"unknown"` when the probe itself failed, which
   * is a different fact and used to be reported as the same one: the Redis-error
   * path returned a byte-identical `{configured:true, lastRunAt:null,
   * stale:null}` to the never-run-yet path, so a monitor could not tell a fleet
   * that has never started from a heartbeat we simply could not read.
   */
  stale: boolean | "unknown" | null;
  /** True only on the probe-failed path, so an alert rule can key on it. */
  probeError?: boolean;
};

type RedisStatus = {
  status: "ok" | "degraded";
  /** Generic code only: the route is public, so no vendor class or message. #1822 */
  reason?:
    | "QUOTA_EXCEEDED"
    | "UNAVAILABLE"
    | "CIRCUIT_OPEN"
    | "MOCK_IN_PRODUCTION";
};

function redisOk(): RedisStatus {
  // The breaker is in-memory: an open one fails locks fast even if this GET succeeded.
  return isRedisCircuitOpen()
    ? { status: "degraded", reason: "CIRCUIT_OPEN" }
    : { status: "ok" };
}

// #E3 — a Stream outage was reportable and nothing reported it.
//
// `getStreamCircuitStatus()` has existed since #1280 2.1 with a docblock saying
// it is "exposed so /api/health can report Stream's breaker rather than
// Redis's", and it was called from nowhere. The `stream` block below therefore
// described reachability but never the breaker, and a Stream outage was visible
// only as `reachable: false` on a probe that could itself hang for thirty
// seconds during the first minutes of the outage (the reason `lib/stream/
// health.ts` grew its own deadline).
//
// It is read HERE, separately from `getStreamStatus`, on purpose: `getStreamStatus`
// is mocked out in tests and is a whole round trip, whereas the breaker is a
// synchronous in-memory read that costs nothing and cannot fail. If the two ever
// disagree, the more specific one (the `stream` block, read inside the probe)
// wins for `breaker.state` and this is the cross-check.
//
// The public health route must not attribute a Redis problem to Stream, so this
// is tagged and named for Stream and nothing else.
function streamBreakerStatus() {
  const s = getStreamCircuitStatus();
  return {
    state: s.state,
    failures: s.failures,
    lastFailure: s.lastFailure ? new Date(s.lastFailure).toISOString() : null,
  };
}

// #1822 Q-7 — the heartbeat GET doubles as the Redis probe, so a quota
// failure (`UpstashError: ERR max requests limit exceeded`) costs no extra command.
async function checkCronHeartbeat(): Promise<{
  cron: CronHeartbeat;
  redis: RedisStatus;
}> {
  if (isMockRedis()) {
    return {
      cron: { configured: false, lastRunAt: null, stale: null },
      // In-memory locks on a production build are not real locks.
      redis:
        process.env.NODE_ENV === "production"
          ? { status: "degraded", reason: "MOCK_IN_PRODUCTION" }
          : { status: "ok" },
    };
  }
  try {
    const lastRunAt = await redis.get<string>("cron:heartbeat:last");
    if (!lastRunAt) {
      return {
        cron: { configured: true, lastRunAt: null, stale: null },
        redis: redisOk(),
      };
    }
    const age = Date.now() - Date.parse(lastRunAt);
    return {
      cron: {
        configured: true,
        lastRunAt,
        stale: Number.isFinite(age) ? age > CRON_HEARTBEAT_STALE_MS : null,
      },
      redis: redisOk(),
    };
  } catch (err) {
    Sentry.logger.warn("Cron heartbeat probe failed", {
      tags: { subsystem: "api" },
      extra: { message: err instanceof Error ? err.message : String(err) },
    });
    return {
      cron: {
        configured: true,
        lastRunAt: null,
        stale: "unknown",
        probeError: true,
      },
      redis: {
        status: "degraded",
        reason: /max requests limit/i.test(String(err))
          ? "QUOTA_EXCEEDED"
          : "UNAVAILABLE",
      },
    };
  }
}

// Above the ~3 s pg connect budget in lib/prisma.ts, well under the function
// ceiling. Armed AFTER the stall yield below, so it measures the database.
const DB_PROBE_BUDGET_MS = 5_000;

// A yield that takes longer than this was not a yield. Warm instances measure
// 0–2 ms; #1124's stall is 24 000–39 000 ms; nothing lives in between.
const STALL_REPORT_THRESHOLD_MS = 1_000;

async function probeDatabase(): Promise<{
  database: "connected" | "unreachable";
  latencyMs: number;
  retried: boolean;
}> {
  const outcome = await probeWithStallRetry(
    // ORM connectivity probe (no raw SQL) — a cheap LIMIT 1 read proves the
    // connection is alive; null (empty table) still means "connected".
    () => prisma.user.findFirst({ select: { id: true } }),
    DB_PROBE_BUDGET_MS,
  );
  if (!outcome.ok) {
    const err = outcome.error;
    Sentry.logger.warn("DB health probe failed", {
      tags: { subsystem: "api" },
      extra: {
        message: err instanceof Error ? err.message : String(err),
        elapsedMs: outcome.elapsedMs,
        timedOut: outcome.timedOut,
        retried: outcome.retried,
      },
    });
  }
  return {
    database: outcome.ok ? "connected" : "unreachable",
    latencyMs: outcome.elapsedMs,
    retried: outcome.retried,
  };
}

export async function GET(request: Request) {
  const includeBetterStack =
    new URL(request.url).searchParams.get("includeBetterStack") === "1";

  // #1557 / #1124 — first thing, before any timer is armed: absorb the
  // cold-instance stall and measure it. Everything below runs on a loop that
  // is actually running. See lib/health/probe.ts for why the order matters.
  const eventLoopStallMs = await measureEventLoopStall();
  const processUptimeMs = Math.round(process.uptime() * 1000);
  if (eventLoopStallMs > STALL_REPORT_THRESHOLD_MS) {
    Sentry.logger.warn("Cold-instance event-loop stall", {
      tags: { subsystem: "api" },
      extra: { eventLoopStallMs, processUptimeMs },
    });
  }

  const {
    database,
    latencyMs: databaseLatencyMs,
    retried,
  } = await probeDatabase();

  const [maintenanceState, stream, betterstack, heartbeat, usage] =
    await Promise.all([
      getMaintenanceState(),
      // #473 — the last unmet acceptance criterion on that issue. The breaker
      // existed but nothing surfaced its state, so a Stream outage was invisible
      // until users reported it. #E3 extended it: the probe now also reports the
      // breaker's own state and whether the webhook secret can verify anything.
      getStreamStatus(),
      includeBetterStack
        ? checkBetterStack()
        : Promise.resolve({
            configured: Boolean(process.env.BETTERSTACK_API_KEY),
            reachable: null,
          }),
      checkCronHeartbeat(),
      // #E5 — Stream quota. Read as a PRECOMPUTED nightly snapshot, not a live
      // count: this endpoint is polled by an external monitor, and computing MAU
      // per poll would mean a keyspace SCAN plus a `Session` read on every
      // request. The cost of this line is 2 Redis commands per uncached call
      // and zero per cached one — see lib/stream/usage.ts for the full
      // accounting against the Upstash 500k cap.
      readStreamUsage(),
    ]);
  const { cron, redis: redisStatus } = heartbeat;

  // Stream being down degrades chat and video but leaves booking, payments and
  // every read path working, so it is reported without failing the check.
  // #1822 Q-7 — a Redis quota failure fails closed on every fail-closed cron
  // job and disables every rate limiter, so it degrades the overall status
  // too, not just the database.
  //
  // #E3 — a webhook secret that cannot verify anything DOES degrade the status,
  // which is the one Stream-side condition that earns it. Everything else about
  // Stream is a vendor availability question with a user-visible retry; a
  // mis-signed webhook is not: every delivery 401s, so `MeetingAttendance` rows
  // stop being written, `call.recording_ready` never becomes a `Recording`, and
  // `call.ended` never closes a `Meeting`. That is the 2026-08-12 outage, whose
  // entire signature was a green platform and zero `WebhookEvent` rows. Degrading
  // here is the point: nothing else in the system was going to say so.
  //
  // #E5 — a crossed Stream quota threshold does NOT degrade the status, and that
  // is deliberate. The platform is not impaired; it is approaching a commercial
  // decision. It is carried in the `usage` block with a stable `worstAlert` for
  // an alert rule to key on, so a budget conversation pages nobody at 3am.
  const webhookSecretBroken =
    stream.webhookSecret.reason === "WEBHOOK_SECRET_OVERRIDE_MISMATCH" ||
    stream.webhookSecret.reason === "API_SECRET_UNSET";

  const status =
    database === "unreachable" ||
    redisStatus.status === "degraded" ||
    webhookSecretBroken ||
    // #E6 — an unreadable maintenance phase is a GUESS reported as a fact. The
    // read still fails open (enforcement is unchanged), but "phase: OFF" from a
    // throwing read is not an answer, and the function log strips `console.*`,
    // so this is the only place it becomes visible.
    maintenanceState.unreadable
      ? "degraded"
      : "healthy";

  return NextResponse.json({
    status,
    database,
    // #1124's stall is a platform latency, not a dependency failure: it is
    // reported here, and in the Sentry log above, but never changes `status`.
    platform: {
      eventLoopStallMs,
      processUptimeMs,
      databaseLatencyMs,
      databaseProbeRetried: retried,
    },
    maintenance: {
      phase: maintenanceState.phase,
      reason: maintenanceState.reason,
      estimatedEnd: maintenanceState.estimatedEnd,
      // #E6 — see above. `false` is the ordinary case; `true` means every other
      // field in this block is a default rather than a reading.
      unreadable: maintenanceState.unreadable,
    },
    stream: {
      ...stream,
      // #E3 — the breaker's own state, read outside the probe. `getStreamStatus`
      // already reports one; this is the same object re-read on the same
      // instance, and it is what makes the claim "this route can see Stream's
      // breaker" true even when the probe itself is mocked out or times out —
      // the failure mode that made the field useless before.
      breaker: streamBreakerStatus(),
    },
    usage: {
      // #1829 — the LEVEL is public; the FIGURES are not.
      //
      // This route is unauthenticated by design (it is what an uptime monitor
      // and a load balancer hit), so anything in its body is public. Publishing
      // exact monthly-active-user counts, billed participant-minutes and the
      // plan CAPS would let anyone track the business's growth — and, more
      // usefully to an attacker, time activity against the Maker-tier ceiling,
      // where Stream does not degrade but simply stops accepting new
      // connections. A cap is the one number worth knowing the shape of before
      // you arrive at it.
      //
      // `worstAlert` stays because it is the operationally load-bearing half and
      // reveals only a bucket (60/80/90%), which a monitor can act on. So can
      // `unmetered` and `estimated`: both are statements about data QUALITY, and
      // a figure nobody can trust is not a figure worth hiding.
      //
      // The absolute numbers are available to an operator on the admin health
      // route, which is session-gated. This is a redaction, not a removal.
      alert: usage.worstAlert,
      quality: {
        // True when the participant-minute sweep dropped rows, so the figure is
        // a floor rather than an estimate. A reader must not treat a low number
        // as good news when it is incomplete.
        unmetered: usage.unmetered,
        estimated: usage.snapshot?.estimated ?? null,
        // Present but possibly null: the snapshot's age is what tells an operator
        // whether to trust the figure, and a stale-by-a-month snapshot with no
        // timestamp reads exactly like a live one.
        computedAt: usage.snapshot?.computedAt ?? null,
      },
      // The WINDOW, not progress through it. The comment this replaces claimed
      // this was "how many days into the window", which would let a reader tell
      // a month-to-date figure from a final one — but it is a constant 30 and
      // says nothing about progress, so that was a claim the field cannot keep.
      // What a reader can actually derive is the bucket: month-to-date, which is
      // what a cap alarm needs. `computedAt` is the timestamp that tells them
      // how stale it is.
      windowDays: usage.meters.mau ? 30 : null,
      windowKind: "calendar-month" as const,
      redacted: true,
    },
    betterstack,
    cron,
    redis: redisStatus,
    timestamp: new Date().toISOString(),
  });
}
