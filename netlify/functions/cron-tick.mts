/**
 * Netlify scheduled ticker — ADR 27 (docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
 *
 * Every five minutes this POSTs the cleanup routes and background destinations in
 * {@link TARGETS}: the money sweeps, the Novu and email outbox relays, the
 * booking sweeps, the session-outcome jobs, the drains, hourly payout
 * processing, the dispute and payout reconcilers, and the money batch jobs,
 * the daily ledger reconcile, the GST register and the quarterly TDS draft
 * inside their calendar windows ({@link TARGET_WINDOWS}), and the housekeeping,
 * compliance and retention jobs. No workflow schedules a registry job, so a
 * target missing here runs nowhere.
 * Only the production deploy dispatches. A tick reads the fleet switch
 * `ops:active_cron_platform` and skips every target unless this host is the
 * active one ({@link otherActivePlatform}), then claims its five-minute slot
 * in Postgres so a second dispatch of the same slot stands down.
 * It never writes money state itself: every target is `CRON_SECRET`-gated and
 * wraps its core in `withCronLock`, so overlapping runs answer 409 from the
 * loser — expected, not an error.
 *
 * Deliberately light: no `@netlify/functions` import, only `zod`, the
 * Sentry-free Better Stack emitter, `process.env` and the global
 * `fetch`/`AbortController` the Netlify Functions runtime already provides. `@sentry/node` and the shared error
 * budget are imported lazily, only for the missing-secret fatal and for
 * {@link alertFailedTargets}.
 *
 * The tick always answers 200; see {@link statusFor} for why.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  capToTick,
  scheduledTargets,
  scheduleFor,
  targetRequest,
  isFirstDueTickOfHour,
  TARGET_WINDOWS,
  TARGET_BACKGROUND_FUNCTIONS,
  type Target,
} from "../../lib/cron/schedule";
import {
  isPlatformErrorBody,
  isRepeatedFailure,
  lastRunFailed,
  streakReportSchema,
  type StreakReport,
} from "../../lib/cron/failure-streak";
import { jobOutcomeSchema, type JobOutcome } from "../../lib/cron/job-outcome";
import { offProductionDeploy } from "../../lib/cron/deploy-context";
import {
  emitTelemetryLog,
  pendingAgesSchema,
  type PendingAges,
} from "../../lib/observability/betterstack-telemetry";

export const config = { schedule: "*/5 * * * *" };

interface TickBody {
  event: "cron-tick";
  /** Sent to every target as `x-tick-id`, so each run row names the tick that dispatched it. */
  tickId: string;
  ok: string[];
  accepted: string[];
  lockHeld: string[];
  /** Failed targets whose fail-closed lease the database could not grant; they write no run row. */
  lockUnavailable: string[];
  failed: { name: string; status: number }[];
  /** Due targets whose idle probe found no work; recorded on the claim row, never dispatched. */
  skippedIdle: string[];
  durationMs: number;
  /** Queue gauges from the slot claim; absent when the claim could not read them. */
  oldestPendingAgeS?: PendingAges;
}

/**
 * #1686 — the HTTP status a tick answers, exported so a test can pin it.
 *
 * Always 200, on purpose. The #1390 review had a tick with a failed target
 * answer 500 so that it would not "self-report healthy"; what that bought was
 * observed in the production function logs on 2026-09-17: Netlify re-invokes a
 * scheduled function that answers 5xx, up to three attempts 4–11 s apart, each
 * one re-firing every due target. With `reconcile-payment-status` failing on
 * every tick, the ticker ran at 3× for weeks. A 5xx buys three invocations and
 * nothing else — the target's own route has already logged its failure, the
 * next due tick retries it, and a warm-tick failure is read from the `failed`
 * list in the JSON line this function logs, not from the status.
 */
export function statusFor(_failed: TickBody["failed"]): number {
  return 200;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * POST one cleanup route and reduce it to a status. Never rejects — a network
 * failure or an aborted request reports as status `0`, which the caller sorts
 * into `failed` the same as any other non-2xx/409 outcome.
 */
async function readResponseText(res: Response): Promise<string> {
  return typeof res.text === "function" ? await res.text().catch(() => "") : "";
}

async function parse503Response(res: Response): Promise<{
  maintenance: boolean;
  lockUnavailable: boolean;
  errorBody?: string;
}> {
  const rawText = await readResponseText(res);
  let body: { phase?: unknown; code?: unknown } | null = null;
  if (rawText) {
    try {
      body = JSON.parse(rawText) as { phase?: unknown; code?: unknown };
    } catch {
      body = null;
    }
  } else if (typeof res.json === "function") {
    body = (await res.json().catch(() => null)) as {
      phase?: unknown;
      code?: unknown;
    } | null;
  }
  const maintenance = typeof body?.phase === "string";
  return {
    maintenance,
    lockUnavailable: body?.code === "CRON_LOCK_UNAVAILABLE",
    ...(!maintenance && rawText ? { errorBody: rawText.slice(0, 500) } : {}),
  };
}

async function hitTarget(
  baseUrl: string,
  secret: string,
  name: Target,
  now: Date,
  deadline: number,
  tickId: string,
): Promise<{
  name: string;
  status: number;
  maintenance?: boolean;
  lockUnavailable?: boolean;
  errorBody?: string;
  outcome?: JobOutcome;
  /** The tick's own abort fired; the target may still be running. */
  aborted?: boolean;
}> {
  const { url, timeoutMs } = targetRequest(baseUrl, name, now);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "sentry-propagate-traces": "false",
        "x-tick-id": tickId,
      },
      signal: controller.signal,
    });
    const parsedOutcome = jobOutcomeSchema.safeParse(
      res.headers.get("x-job-outcome"),
    );
    const outcome = parsedOutcome.success ? parsedOutcome.data : undefined;
    // Only the twin's own maintenance refusal carries `phase`; a platform or
    // dependency 503 does not, and must stay visible as a failure (#1598 P1-W03).
    let maintenance = false;
    let lockUnavailable = false;
    let errorBody: string | undefined;
    if (res.status === 503) {
      const parsed = await parse503Response(res);
      maintenance = parsed.maintenance;
      lockUnavailable = parsed.lockUnavailable;
      errorBody = parsed.errorBody;
    } else if (bucketFor(res.status, false, name, outcome) === "failed") {
      const rawText = await readResponseText(res);
      if (rawText) errorBody = rawText.slice(0, 500);
    }
    if (
      bucketFor(res.status, maintenance, name, outcome) === "failed" &&
      errorBody
    ) {
      console.error(
        JSON.stringify({
          event: "cron-tick-target-failed",
          target: name,
          status: res.status,
          errorBody,
        }),
      );
    }
    return {
      name,
      status: res.status,
      outcome,
      maintenance,
      lockUnavailable,
      ...(errorBody ? { errorBody } : {}),
    };
  } catch {
    return {
      name,
      status: 0,
      maintenance: false,
      aborted: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A retry needs at least this much of the tick's target budget left. */
const RETRY_MIN_REMAINING_MS = 5_000;

/**
 * A request that never reached the app (a connection failure, not our abort,
 * or Netlify's own 500 page) is retried once while the tick has time left.
 */
export function isRetryable(result: {
  status: number;
  aborted?: boolean;
  errorBody?: string;
}): boolean {
  if (result.status === 0) return result.aborted !== true;
  return result.status === 500 && isPlatformErrorBody(result.errorBody);
}

async function hitTargetOnceMore(
  ...args: Parameters<typeof hitTarget>
): ReturnType<typeof hitTarget> {
  const first = await hitTarget(...args);
  const deadline = args[4];
  if (!isRetryable(first) || deadline - Date.now() < RETRY_MIN_REMAINING_MS) {
    return first;
  }
  console.log(
    JSON.stringify({
      event: "cron-tick-target-retry",
      target: first.name,
      status: first.status,
    }),
  );
  const retried = await hitTarget(...args);
  // A 409 here is likely the lease the crashed first call took; keep its failure.
  return retried.status === 409 ? first : retried;
}

/** Targets whose 207 means some rows failed; every other target's 207 is a successful run that flagged rows. */
const PARTIAL_FAILURE_TARGETS: ReadonlySet<string> = new Set([
  "process-payouts",
  "reconcile-ledgers",
  // A 207 here is a captured top-up still not credited to its wallet.
  "sweep-orphaned-topup-captures",
  ...Object.keys(TARGET_WINDOWS),
]);

/**
 * Which bucket a target's status lands in; exported so a test can pin it.
 * 409 is the cron lock's loser; a 503 whose body carries the maintenance
 * `phase` is a twin refusing inside a hold — both expected, neither a failure.
 * A bare 503 has no such marker and stays failed. A 207 is failed only for
 * {@link PARTIAL_FAILURE_TARGETS}.
 */
export function bucketFor(
  status: number,
  maintenance = false,
  name = "",
  outcome?: JobOutcome,
): "ok" | "accepted" | "held" | "failed" {
  if (outcome === "failure" || outcome === "partial_failure") return "failed";
  if (outcome === "held") return "held";
  const backgroundTarget = Object.entries(TARGET_BACKGROUND_FUNCTIONS).some(
    ([target]) => target === name,
  );
  if (backgroundTarget) return status === 202 ? "accepted" : "failed";
  if (outcome === "success" && status === 200) return "ok";
  if (status === 200) return "ok";
  if (status === 207) {
    return PARTIAL_FAILURE_TARGETS.has(name) ? "failed" : "ok";
  }
  if (status === 409 || (status === 503 && maintenance)) return "held";
  return "failed";
}

/**
 * Which failed targets are reported to Sentry itself. The ingest canary is
 * excluded: its unhealthy verdict is a 207 finding, and a crashed canary is
 * caught by the freshness probe, never by the system whose ingest it checks.
 */
export function reportableToSentry(name: string): boolean {
  return name !== "sentry-ingest-canary";
}

/** The ticker shares the app's single public DSN. */
function tickerSentryDsn(): string | undefined {
  return process.env.NEXT_PUBLIC_SENTRY_DSN;
}

/** A missing secret is a silent fleet outage; page Sentry, not just the log. */
async function alertMissingSecret(error: string): Promise<void> {
  try {
    const Sentry = await import("@sentry/node");
    const { applyErrorBudget } = await import("../../sentry.shared.config");
    const { scrubSentryEvent } =
      await import("../../lib/observability/sentry-scrubber");
    Sentry.init({
      dsn: tickerSentryDsn(),
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      registerEsmLoaderHooks: false,
      beforeSend(event) {
        const budgeted = applyErrorBudget(event);
        return budgeted === null ? null : scrubSentryEvent(budgeted);
      },
    });
    Sentry.captureMessage(error, "fatal");
    await Sentry.flush(2_000);
  } catch (err) {
    console.error(JSON.stringify({ event: "cron-tick", sentry: String(err) }));
  }
}

/** The Sentry event for a target that keeps failing: one error issue per target. */
export function buildFailedTargetEvent(failed: {
  name: string;
  status: number;
  errorBody?: string;
}) {
  return {
    message: `cron-tick: target ${failed.name} failed`,
    level: "error" as const,
    fingerprint: ["cron-tick", failed.name],
    tags: {
      subsystem: "cron",
      op: "cron-tick",
      target: failed.name,
      ...(isPlatformErrorBody(failed.errorBody) ? { class: "platform" } : {}),
    },
    contexts: {
      tick: {
        target: failed.name,
        // 0 is this module's "never got an answer" value, not an HTTP status.
        status: failed.status,
        outcome: failed.status === 0 ? ("network" as const) : ("http" as const),
        ...(failed.errorBody ? { errorBody: failed.errorBody } : {}),
      },
    },
  };
}

/** Bounded read of each failing target's last COMPLETED run; null means history unknown. */
async function fetchStreaks(
  baseUrl: string,
  secret: string,
  names: string[],
): Promise<StreakReport | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(
      `${baseUrl}/api/health/jobs/streaks?targets=${names.map(encodeURIComponent).join(",")}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const parsed = streakReportSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Judges each failing target on its first due tick of the hour; only repeats page Sentry. */
async function alertFailedTargets(
  failed: { name: string; status: number; errorBody?: string }[],
  tickStart: Date,
  history: { baseUrl: string; secret: string },
): Promise<void> {
  // Judge against the tick's start: targets can run 20 s past a minute boundary.
  const due = failed.filter((f) => isFirstDueTickOfHour(f.name, tickStart));
  if (due.length === 0) return;
  const streaks = await fetchStreaks(
    history.baseUrl,
    history.secret,
    due.map((f) => f.name),
  );
  // A one-off stays in the logs; only a repeat (isRepeatedFailure) reaches Sentry.
  const repeated = due.filter((f) =>
    isRepeatedFailure(
      scheduleFor(f.name)?.everyMinutes ?? 5,
      streaks?.[f.name],
      tickStart,
    ),
  );
  for (const f of due) {
    if (repeated.includes(f)) continue;
    console.warn(
      JSON.stringify({
        event: "cron-tick.target-failed-once",
        target: f.name,
        status: f.status,
        ...(isPlatformErrorBody(f.errorBody) ? { class: "platform" } : {}),
      }),
    );
  }
  if (repeated.length === 0) return;
  try {
    const Sentry = await import("@sentry/node");
    const { applyErrorBudget } = await import("../../sentry.shared.config");
    const { scrubSentryEvent } =
      await import("../../lib/observability/sentry-scrubber");
    Sentry.init({
      dsn: tickerSentryDsn(),
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      registerEsmLoaderHooks: false,
      beforeSend(event) {
        const budgeted = applyErrorBudget(event);
        return budgeted === null ? null : scrubSentryEvent(budgeted);
      },
      // Same posture as the app: no IP, no cookies, no headers. The ticker's
      // only caller is the Netlify scheduler, so there is nothing to collect.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        queryParams: false,
        httpBodies: [],
        stackFrameVariables: false,
      },
    });
    for (const f of repeated) {
      const event = buildFailedTargetEvent(f);
      Sentry.captureMessage(event.message, event);
    }
    await Sentry.flush(2_000);
  } catch (err) {
    // Telemetry must never be the reason a tick throws.
    console.error(JSON.stringify({ event: "cron-tick", sentry: String(err) }));
  }
}

/**
 * #1861 P4a — one Sentry cron monitor for the whole ticker (not per target:
 * a dedicated monitor per /api/cleanup/* target is billed at $0.78/month
 * each and out of scope). Dependency-free, unlike alertMissingSecret above —
 * Sentry's HTTP check-in (https://docs.sentry.io/product/crons/getting-started/http/)
 * is a plain POST, so no `@sentry/node` import is needed on the happy path.
 *
 * The endpoint is built by parsing NEXT_PUBLIC_SENTRY_DSN as Sentry's own DSN shape
 * (`https://<publicKey>@<host>/<projectId>`) into
 * `https://<host>/api/<projectId>/cron/<monitorSlug>/<publicKey>/`, which is
 * exactly the template that doc page gives. A POST body carrying
 * `monitor_config` upserts the monitor's schedule/margins on every check-in,
 * so no separate Sentry UI/API step is needed to create `cron-tick` first —
 * verified against the doc's own POST example, which upserts the same way.
 */
const CRON_MONITOR_SLUG = "cron-tick";
const CRON_CHECKIN_TIMEOUT_MS = 2_000;

function cronCheckInUrl(): string | null {
  const dsn = tickerSentryDsn();
  if (!dsn) return null;
  try {
    const parsed = new URL(dsn);
    const publicKey = parsed.username;
    const projectId = parsed.pathname.replace(/^\//, "");
    if (!publicKey || !projectId || !parsed.host) return null;
    return `${parsed.protocol}//${parsed.host}/api/${projectId}/cron/${CRON_MONITOR_SLUG}/${publicKey}/`;
  } catch {
    return null;
  }
}

/**
 * One check-in call. Never throws and bounded to CRON_CHECKIN_TIMEOUT_MS —
 * a Sentry outage or a malformed DSN must add no latency and never fail the
 * tick; a missed check-in shows up as a Sentry-side miss alert, which is the
 * whole point of the monitor.
 */
async function sendCheckIn(
  status: "ok" | "error",
  durationMs: number,
): Promise<void> {
  const url = cronCheckInUrl();
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRON_CHECKIN_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        duration: durationMs / 1000,
        // Matches `config.schedule` above — this is the single source for
        // both Netlify's own trigger and Sentry's missed-check-in alerting.
        monitor_config: {
          schedule: { type: "crontab", value: config.schedule },
          // Three minutes of silence past the cadence is a real miss.
          checkin_margin: 3,
          // The first tick after every deploy aborts most targets (status 0),
          // so one failed tick is noise; three in a row is an outage.
          failure_issue_threshold: 3,
          recovery_threshold: 1,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok)
      console.error(
        JSON.stringify({
          event: "cron-checkin-rejected",
          status: response.status,
        }),
      );
  } catch {
    console.error(JSON.stringify({ event: "cron-checkin-unavailable" }));
    // Belt and suspenders: fetch failures are swallowed here too, even
    // though every call site also treats this as fire-and-forget.
  } finally {
    clearTimeout(timer);
  }
}

const ACTIVE_PLATFORM_KEY = "ops:active_cron_platform";
const THIS_PLATFORM = "netlify";
const ACTIVE_PLATFORM_TIMEOUT_MS = 1_000;
const activePlatformReply = z.object({ result: z.string().nullable() });

// A switch read that fails runs this tick, so it must leave a log line: it is the
// only trace that a pause (for example `paused-prelaunch`) was bypassed.
function failOpen(reason: string): null {
  console.warn(
    JSON.stringify({ event: "cron-tick-fleet-switch-unreadable", reason }),
  );
  return null;
}

/**
 * The platform that owns the fleet when it is not this one, else null. One
 * Upstash REST GET per tick; an absent key, missing credentials, a timeout, an
 * error or an unreadable reply all mean "run", because Netlify is the active
 * host unless the key says otherwise.
 */
export async function otherActivePlatform(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  let base = env.UPSTASH_REDIS_REST_URL ?? "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  if (!base || !token) return null;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ACTIVE_PLATFORM_TIMEOUT_MS,
  );
  try {
    const res = await fetchImpl(
      `${base}/get/${encodeURIComponent(ACTIVE_PLATFORM_KEY)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) return failOpen(`status ${res.status}`);
    const parsed = activePlatformReply.safeParse(await res.json());
    if (!parsed.success) return failOpen("unparsable reply");
    const platform = parsed.data.result;
    return platform === null || platform === THIS_PLATFORM ? null : platform;
  } catch (err) {
    return failOpen(err instanceof Error ? err.name : "fetch error");
  } finally {
    clearTimeout(timer);
  }
}

const SLOT_MS = 5 * 60_000;

/** The tick's id: a custom (version 8) UUID hashed from the five-minute slot, so a second dispatch carries the same id. */
export function tickIdForSlot(slot: Date): string {
  const hex = createHash("sha256")
    .update(`cron-tick:${slot.toISOString()}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Covers a cold start plus the app's idle probes and queue gauges (2.75 s worst case), its commit and the claim insert. */
const TICK_CLAIM_TIMEOUT_MS = 5_000;
const tickClaimReply = z.object({
  claimed: z.boolean(),
  idle: z.array(z.string()).optional(),
  pendingAges: pendingAgesSchema.optional(),
});

/**
 * Claims the slot in Postgres through the app, which also names the scheduled
 * targets its probes found idle and the queue gauges. `claimed` is false only
 * when another dispatch holds the slot; an unreachable or unreadable reply runs
 * every target and carries no gauges.
 */
export async function claimTickSlot(
  baseUrl: string,
  secret: string,
  tickId: string,
  slot: Date,
  scheduled: readonly Target[],
  fetchImpl: typeof fetch = fetch,
): Promise<{
  claimed: boolean;
  idle: ReadonlySet<string>;
  pendingAges?: PendingAges;
}> {
  const runAll = { claimed: true, idle: new Set<string>() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TICK_CLAIM_TIMEOUT_MS);
  try {
    const query = `tickId=${encodeURIComponent(tickId)}&slot=${encodeURIComponent(slot.toISOString())}&due=${scheduled.map(encodeURIComponent).join(",")}`;
    const res = await fetchImpl(`${baseUrl}/api/health/jobs/tick?${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    if (!res.ok) return runAll;
    const parsed = tickClaimReply.safeParse(await res.json());
    if (!parsed.success) return runAll;
    return {
      claimed: parsed.data.claimed,
      idle: new Set(
        (parsed.data.idle ?? []).filter((name) =>
          scheduled.some((target) => target === name),
        ),
      ),
      ...(parsed.data.pendingAges
        ? { pendingAges: parsed.data.pendingAges }
        : {}),
    };
  } catch {
    return runAll;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accepted background targets whose newest finished run failed: a 202 only
 * admits the run, so the previous run's outcome stands in for the target's.
 */
async function failedBackgroundTargets(
  accepted: string[],
  history: { baseUrl: string; secret: string },
): Promise<string[]> {
  if (accepted.length === 0) return [];
  const streaks = await fetchStreaks(history.baseUrl, history.secret, accepted);
  return accepted.filter((name) => lastRunFailed(streaks?.[name]));
}

/** One Better Stack heartbeat per completed tick; unset skips it, a failure never fails the tick. */
async function pingHeartbeat(): Promise<void> {
  const url = process.env.BETTERSTACK_HEARTBEAT_URL;
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.error(
        JSON.stringify({ event: "heartbeat-rejected", status: res.status }),
      );
    }
  } catch {
    console.error(JSON.stringify({ event: "heartbeat-unavailable" }));
  } finally {
    clearTimeout(timer);
  }
}

export default async function cronTick(
  _req: Request,
  context?: unknown,
): Promise<Response> {
  const started = Date.now();
  // Netlify's "Run now" also fires previews and branch deploys; only production dispatches.
  const deployContext = offProductionDeploy(context);
  if (deployContext) {
    console.log(
      JSON.stringify({ event: "cron-tick", skipped: true, deployContext }),
    );
    return jsonResponse({ skipped: true, deployContext }, 200);
  }
  const tickDate = new Date(Math.round(started / 60_000) * 60_000);
  const slot = new Date(Math.floor(tickDate.getTime() / SLOT_MS) * SLOT_MS);
  const tickId = tickIdForSlot(slot);
  const otherPlatform = await otherActivePlatform();
  if (otherPlatform !== null) {
    console.log(
      JSON.stringify({ event: "cron-tick", skipped: true, otherPlatform }),
    );
    return jsonResponse({ skipped: true, otherPlatform }, 200);
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    const error =
      "CRON_SECRET is not set — the ticker cannot authenticate to /api/cleanup/*";
    console.error(JSON.stringify({ event: "cron-tick", error }));
    await Promise.all([
      alertMissingSecret(error),
      emitTickSummary(
        {
          event: "cron-tick",
          tickId,
          ok: [],
          accepted: [],
          lockHeld: [],
          lockUnavailable: [],
          failed: [],
          skippedIdle: [],
          durationMs: Date.now() - started,
        },
        error,
      ),
    ]);
    // #1686 — a 5xx would only be re-invoked three times against the same
    // missing secret; the log line and the Sentry message are the signal.
    return jsonResponse({ error }, 200);
  }

  // Netlify sets URL to the site's primary deploy URL; CRON_TICK_BASE_URL is
  // the override for a host where URL resolves somewhere other than this app.
  // S8786 — a quantified trailing-slash regex risks catastrophic
  // backtracking; strip one slash at a time instead.
  let baseUrl = process.env.CRON_TICK_BASE_URL || process.env.URL || "";
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const scheduled = scheduledTargets(tickDate);
  const claim = await claimTickSlot(baseUrl, secret, tickId, slot, scheduled);
  if (!claim.claimed) {
    console.log(
      JSON.stringify({ event: "cron-tick", duplicate: true, tickId }),
    );
    return jsonResponse({ duplicate: true, tickId }, 200);
  }
  const skippedIdle = scheduled.filter((name) => claim.idle.has(name));
  const targets = capToTick(scheduled.filter((name) => !claim.idle.has(name)));

  const settled = await Promise.allSettled(
    targets.map((name) =>
      hitTargetOnceMore(
        baseUrl,
        secret,
        name,
        tickDate,
        started + 24_000,
        tickId,
      ),
    ),
  );

  const ok: string[] = [];
  const accepted: string[] = [];
  const lockHeld: string[] = [];
  const lockUnavailable: string[] = [];
  const failed: { name: string; status: number }[] = [];
  const failedForAlert: { name: string; status: number; errorBody?: string }[] =
    [];

  settled.forEach((result, i) => {
    const name = targets[i];
    // hitTarget never rejects, but a defensive fallback keeps a Promise API
    // surprise from throwing out of the handler instead of being counted.
    const status = result.status === "fulfilled" ? result.value.status : 0;
    const maintenance =
      result.status === "fulfilled" && result.value.maintenance === true;
    const errorBody =
      result.status === "fulfilled" ? result.value.errorBody : undefined;
    const outcome =
      result.status === "fulfilled" ? result.value.outcome : undefined;
    const bucket = bucketFor(status, maintenance, name, outcome);
    if (bucket === "ok") ok.push(name);
    else if (bucket === "accepted") accepted.push(name);
    else if (bucket === "held") lockHeld.push(name);
    else {
      if (result.status === "fulfilled" && result.value.lockUnavailable)
        lockUnavailable.push(name);
      failed.push({ name, status });
      failedForAlert.push({
        name,
        status,
        ...(errorBody ? { errorBody } : {}),
      });
    }
  });

  for (const name of await failedBackgroundTargets(accepted, {
    baseUrl,
    secret,
  })) {
    accepted.splice(accepted.indexOf(name), 1);
    failed.push({ name, status: 202 });
    failedForAlert.push({
      name,
      status: 202,
      errorBody: "last background run failed",
    });
  }

  const durationMs = Date.now() - started;
  const body: TickBody = {
    event: "cron-tick",
    tickId,
    ok,
    accepted,
    lockHeld,
    lockUnavailable,
    failed,
    skippedIdle,
    durationMs,
    ...(claim.pendingAges ? { oldestPendingAgeS: claim.pendingAges } : {}),
  };
  console.log(JSON.stringify(body));
  // Check-in and alert waiting share the remaining ticker budget; aborts do not cancel target work.
  await Promise.all([
    sendCheckIn(failed.length > 0 ? "error" : "ok", durationMs),
    emitTickSummary(body),
    pingHeartbeat(),
    boundedAlert(
      failedForAlert.filter((f) => reportableToSentry(f.name)),
      tickDate,
      started + 27_000,
      { baseUrl, secret },
    ),
  ]);

  // #1686 — 200 even with a non-empty `failed`; see statusFor.
  return jsonResponse(body, statusFor(failed));
}

/** One Better Stack summary per tick, the event the freshness alert keys on; never throws. */
async function emitTickSummary(body: TickBody, error?: string): Promise<void> {
  await emitTelemetryLog(
    {
      level: error || body.failed.length > 0 ? "error" : "info",
      message: "cron-tick summary",
      category: "CRON",
      tickId: body.tickId,
      durationMs: body.durationMs,
      okCount: body.ok.length,
      acceptedCount: body.accepted.length,
      lockHeld: body.lockHeld,
      lockUnavailableCount: body.lockUnavailable.length,
      lockUnavailable: body.lockUnavailable,
      failed: body.failed,
      skippedIdleCount: body.skippedIdle.length,
      ...(body.oldestPendingAgeS
        ? { oldestPendingAgeS: body.oldestPendingAgeS }
        : {}),
      ...(error ? { error } : {}),
    },
    fetch,
  );
}

async function boundedAlert(
  failed: Parameters<typeof alertFailedTargets>[0],
  tickDate: Date,
  deadline: number,
  history: { baseUrl: string; secret: string },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      alertFailedTargets(failed, tickDate, history),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
