/**
 * Netlify scheduled ticker — ADR 27 (docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
 *
 * ADR 22 measured GitHub Actions delivering a sub-hourly `cron:` schedule
 * roughly once every hundred minutes (#866), so the fleet's money sweeps were
 * running six times slower than their declared cadence. This function POSTs
 * the latency-sensitive `/api/cleanup/*` routes every five minutes (ten money
 * sweeps, since #1633 the ledger reconcile backstop, since #1654 the Novu
 * outbox relay every tick and the email outbox relay on every third tick,
 * and since #1583/#1589 five booking sweeps on every third tick, two of them
 * on the 20 s tier) instead of waiting on Actions. It never writes money state itself: every
 * target is `CRON_SECRET`-gated and wraps its core in `withCronLock`, so a
 * tick that overlaps a GitHub Actions run (or another tick) answers 409 from
 * the loser — expected, not an error — and Actions stays as the unbounded
 * daily/weekly scheduler and backstop (#1356).
 *
 * Deliberately dependency-free: no `@netlify/functions` import, only
 * `process.env` and the global `fetch`/`AbortController` the Netlify
 * Functions runtime already provides. The one exception is a lazy
 * `@sentry/node` import on the missing-secret path (#1582 F-P2-02).
 *
 * #1686 — the tick always answers 200; see {@link statusFor} for why a 5xx
 * from a scheduled function costs three invocations and reports nothing.
 */

export const config = { schedule: "*/5 * * * *" };

/** Relative to `/api/cleanup/`. Order is cosmetic — every request fires in parallel. */
const TARGETS = [
  "sweep-stuck-webhook-events",
  "cascade-refund-earnings",
  "reconcile-refunds",
  "abandoned-payments",
  "reconcile-payment-status",
  "reconcile-orphaned-confirmations",
  "sweep-orphaned-topup-captures",
  "dispatch-outbound-webhooks",
  "sync-payment-earnings",
  "release-earnings",
  // #1633 — the backstop for the ledger reconcile driver: one chunk per tick
  // of whatever full-scope run is in flight, IDLE otherwise.
  "reconcile-ledgers",
  // #1648 / #1654 — the email outbox relay; every 15 minutes, see TARGET_EVERY_MINUTES.
  "retry-failed-emails",
  // #1654 — the Novu outbox relay, every tick.
  "drain-notification-outbox",
  // #1583 E-P0-04 / #1589 P-P0-01, N-P1-03 / #1591 J1-P1-05 / #1599 C-P1-06 —
  // the booking sweeps whose hourly Actions twin let a lapsed pay-link, a
  // stale proposal, a missed reminder or a dead hold sit for ~100 minutes.
  // Every 15 minutes, see TARGET_EVERY_MINUTES; none of the five reads
  // `limit`, so they get no entry in TARGET_LIMITS.
  "expire-unpaid-trials",
  "reschedule-proposals",
  "appointment-reminders",
  "tentative-occurrences",
  "expire-stale-requests",
  // #1780 row 4 — refunds a cancelled class session nobody made up in 14 days.
  "settle-cancelled-sessions",
  // #1846 N2 — re-drives the auto-refunds the capture webhook tried once.
  "retry-auto-refunds",
] as const;

type Target = (typeof TARGETS)[number];

/** The batch size a target gets when it is not listed in {@link TARGET_LIMITS}. */
const DEFAULT_LIMIT = 50;

/**
 * #1459 — per-target overrides for the batch size. Fifty rows is only the right
 * bite for a sweep whose per-row cost is a database write; `abandoned-payments`
 * also makes a gateway round trip per payment, and at fifty it could not finish
 * inside {@link PER_TARGET_TIMEOUT_MS} on any tick. The unbounded GitHub Actions
 * run is the backstop for whatever a small bite leaves behind.
 */
const TARGET_LIMITS: Partial<Record<Target, number | null>> = {
  "abandoned-payments": 10,
  // null — send no `limit`; a chunk is bounded by the route's own soft deadline.
  "reconcile-ledgers": null,
  // #1654 — paced at 8 sends/s plus a provider round trip each, twenty rows
  // fits its timeout; the Actions run drains the rest unbounded.
  "retry-failed-emails": 20,
  // #1654 — one Novu round trip per row under a 5 s client timeout; twenty
  // rows stays inside the target timeout even when Novu is slow.
  "drain-notification-outbox": 20,
  // #1708 — one Stream round trip per unchanneled row; ten fits the 20 s budget.
  "reconcile-orphaned-confirmations": 10,
  // #1780 — a gateway refund per seat; ten sessions fit the 20 s budget.
  "settle-cancelled-sessions": 10,
  // #1846 N2 — a gateway refund per payment, same bite as the session sweep.
  "retry-auto-refunds": 10,
};

/**
 * #1654 — targets that run on a multiple of the five-minute tick. A missing
 * entry means every tick. The check is on the wall-clock minute, so a late
 * tick (Netlify fires within the minute) still counts as its slot.
 */
// #1792 — Upstash REST hit its 500k request cap (2026-09-21: every fail-closed
// money cron red with CronLockUnavailableError). Per-invocation Redis cost
// (maintenance read + lock acquire + heartbeat) dominates, so cadence — not
// batch size — is the burn lever. Targets with an Actions twin at equal or
// better cadence ride the 15-minute slots; the ticker-only Novu relay rides
// every 10. #1822 Q-3 — the two reconcile confirms left every-tick too
// (≈83k commands/month); their 30-min Actions twins stay the backstop.
const TARGET_EVERY_MINUTES: Partial<Record<Target, number>> = {
  "sweep-stuck-webhook-events": 15,
  "sweep-orphaned-topup-captures": 15,
  "dispatch-outbound-webhooks": 15,
  "drain-notification-outbox": 10,
  "retry-failed-emails": 15,
  // #1686 — six sweeps whose Actions twin already tolerates 15 min; a 5 min
  // tick on twelve targets was a cold burst billed as duration (ticket #1112198).
  "reconcile-ledgers": 15,
  "sync-payment-earnings": 15,
  "release-earnings": 15,
  "cascade-refund-earnings": 15,
  "reconcile-refunds": 15,
  "abandoned-payments": 15,
  // #1822 Q-3 — see the block comment above; moved off every-tick.
  "reconcile-payment-status": 15,
  "reconcile-orphaned-confirmations": 15,
  // #1583 E-P0-04 — the five booking sweeps: ≈ +20 invocations/hour on top of
  // the #1686 budget; the hourly Actions runs stay the unbounded backstop.
  "expire-unpaid-trials": 15,
  "reschedule-proposals": 15,
  "appointment-reminders": 15,
  "tentative-occurrences": 15,
  "expire-stale-requests": 15,
  "settle-cancelled-sessions": 15,
  "retry-auto-refunds": 15,
};

/** The targets due on this tick; exported so a test can pin the cadence. */
export function dueTargets(now: Date): Target[] {
  const minute = now.getUTCMinutes();
  return TARGETS.filter((name) => {
    const every = TARGET_EVERY_MINUTES[name];
    return every === undefined || minute % every < 5;
  });
}

/** Extra query a target needs beyond `limit`. */
const TARGET_QUERIES: Partial<Record<Target, string>> = {
  "reconcile-ledgers": "resume=1",
};

/** Well under the 26 s Next function ceiling and the 30 s scheduled-function cap. */
const PER_TARGET_TIMEOUT_MS = 6_000;

/** A reconcile chunk takes ~13 s deployed; 20 s still sits under the 30 s scheduled cap. */
const TARGET_TIMEOUTS_MS: Partial<Record<Target, number>> = {
  "reconcile-ledgers": 20_000,
  // #1654 — twenty paced sends; the cron lock makes an overlap a 409, not a double send.
  "retry-failed-emails": 20_000,
  "drain-notification-outbox": 20_000,
  // #1708 — one Stream round trip per unchanneled row; 6 s aborted every tick.
  "reconcile-orphaned-confirmations": 20_000,
  // #1583 E-P0-04 — per-row outbox staging (reminders) and gateway refunds
  // (stale requests) do not fit 6 s on a cold instance; the cron lock makes
  // an overlap with the Actions run a 409, not a double run.
  "appointment-reminders": 20_000,
  "expire-stale-requests": 20_000,
  "settle-cancelled-sessions": 20_000,
  "retry-auto-refunds": 20_000,
};

/** The request one target gets; exported so a test can pin it without a Netlify runtime. */
export function targetRequest(
  baseUrl: string,
  name: Target,
): { url: string; timeoutMs: number } {
  const limit = name in TARGET_LIMITS ? TARGET_LIMITS[name] : DEFAULT_LIMIT;
  const query = [
    limit === null || limit === undefined ? null : `limit=${limit}`,
    TARGET_QUERIES[name] ?? null,
  ]
    .filter((q): q is string => q !== null)
    .join("&");
  return {
    url: `${baseUrl}/api/cleanup/${name}${query ? `?${query}` : ""}`,
    timeoutMs: TARGET_TIMEOUTS_MS[name] ?? PER_TARGET_TIMEOUT_MS,
  };
}

interface TickBody {
  event: "cron-tick";
  ok: string[];
  lockHeld: string[];
  failed: { name: string; status: number }[];
  durationMs: number;
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
 * GitHub Actions twin is the backstop, and a warm-tick failure is read from the
 * `failed` list in the JSON line this function logs, not from the status.
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
async function hitTarget(
  baseUrl: string,
  secret: string,
  name: Target,
): Promise<{ name: string; status: number; maintenance?: boolean }> {
  const { url, timeoutMs } = targetRequest(baseUrl, name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    // Only the twin's own maintenance refusal carries `phase`; a platform or
    // dependency 503 does not, and must stay visible as a failure (#1598 P1-W03).
    let maintenance = false;
    if (res.status === 503) {
      const body = (await res.json().catch(() => null)) as {
        phase?: unknown;
      } | null;
      maintenance = typeof body?.phase === "string";
    }
    return { name, status: res.status, maintenance };
  } catch {
    return { name, status: 0, maintenance: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which bucket a target's status lands in; exported so a test can pin it.
 * 409 is the cron lock's loser; a 503 whose body carries the maintenance
 * `phase` is a twin refusing inside a hold — both expected, neither a failure.
 * A bare 503 has no such marker and stays failed (#1598 P1-W03).
 */
export function bucketFor(
  status: number,
  maintenance = false,
): "ok" | "held" | "failed" {
  if (status === 200 || status === 207) return "ok";
  if (status === 409 || (status === 503 && maintenance)) return "held";
  return "failed";
}

/** #1582 F-P2-02 — a missing secret is a silent fleet outage; page Sentry, not just the log. */
async function alertMissingSecret(error: string): Promise<void> {
  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
    Sentry.captureMessage(error, "fatal");
    await Sentry.flush(2_000);
  } catch (err) {
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
 * The endpoint is built by parsing SENTRY_DSN as Sentry's own DSN shape
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
  const dsn = process.env.SENTRY_DSN;
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
    await fetch(url, {
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
  } catch {
    // Belt and suspenders: fetch failures are swallowed here too, even
    // though every call site also treats this as fire-and-forget.
  } finally {
    clearTimeout(timer);
  }
}

export default async function cronTick(_req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    const error =
      "CRON_SECRET is not set — the ticker cannot authenticate to /api/cleanup/*";
    console.error(JSON.stringify({ event: "cron-tick", error }));
    await alertMissingSecret(error);
    // #1686 — a 5xx would only be re-invoked three times against the same
    // missing secret; the log line and the Sentry message are the signal.
    return jsonResponse({ error }, 200);
  }

  // Netlify sets URL to the site's primary deploy URL; CRON_TICK_BASE_URL is
  // the override for local runs (`netlify dev`) and any deploy where URL
  // resolves somewhere other than this app.
  // S8786 — a quantified trailing-slash regex risks catastrophic
  // backtracking; strip one slash at a time instead.
  let baseUrl = process.env.CRON_TICK_BASE_URL || process.env.URL || "";
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const started = Date.now();
  const targets = dueTargets(new Date(started));

  const settled = await Promise.allSettled(
    targets.map((name) => hitTarget(baseUrl, secret, name)),
  );

  const ok: string[] = [];
  const lockHeld: string[] = [];
  const failed: { name: string; status: number }[] = [];

  settled.forEach((result, i) => {
    const name = targets[i];
    // hitTarget never rejects, but a defensive fallback keeps a Promise API
    // surprise from throwing out of the handler instead of being counted.
    const status = result.status === "fulfilled" ? result.value.status : 0;
    const maintenance =
      result.status === "fulfilled" && result.value.maintenance === true;
    const bucket = bucketFor(status, maintenance);
    if (bucket === "ok") ok.push(name);
    else if (bucket === "held") lockHeld.push(name);
    else failed.push({ name, status });
  });

  const durationMs = Date.now() - started;
  const body: TickBody = {
    event: "cron-tick",
    ok,
    lockHeld,
    failed,
    durationMs,
  };
  console.log(JSON.stringify(body));

  // #1861 P4a — one heartbeat check-in per tick, sent after the targets so it
  // never delays them. Health follows `failed`, not the (always-200) HTTP
  // status; see statusFor's #1686 rationale for why the two diverge.
  await sendCheckIn(failed.length > 0 ? "error" : "ok", durationMs);

  // #1686 — 200 even with a non-empty `failed`; see statusFor.
  return jsonResponse(body, statusFor(failed));
}
