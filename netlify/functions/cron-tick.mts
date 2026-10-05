/**
 * Netlify scheduled ticker — ADR 27 (docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
 *
 * Every five minutes this POSTs the `/api/cleanup/*` routes listed in
 * {@link TARGETS}: the money sweeps, the ledger reconcile, the Novu and email
 * outbox relays, the booking sweeps, the session-outcome jobs, the data-export
 * drain (every 10 min) and the moderation/erasure retry drain (every 30 min).
 * GitHub Actions runs the daily/weekly batch jobs and is NOT a backstop for a
 * ticker target: a target missing here runs nowhere unless a workflow names it.
 * It never writes money state itself: every target is `CRON_SECRET`-gated and
 * wraps its core in `withCronLock`, so overlapping runs answer 409 from the
 * loser — expected, not an error.
 *
 * Deliberately dependency-free: no `@netlify/functions` import, only
 * `process.env` and the global `fetch`/`AbortController` the Netlify
 * Functions runtime already provides. `@sentry/node` and the shared error
 * budget are imported lazily, only for the missing-secret fatal and for
 * {@link alertFailedTargets}.
 *
 * The tick always answers 200; see {@link statusFor} for why.
 */

export const config = { schedule: "*/5 * * * *" };

/** Relative to `/api/cleanup/`. Order is cosmetic — every request fires in parallel. */
const TARGETS = [
  "sweep-stuck-webhook-events",
  "reconcile-refunds",
  "abandoned-payments",
  "reconcile-payment-status",
  "reconcile-orphaned-confirmations",
  "sweep-orphaned-topup-captures",
  "dispatch-outbound-webhooks",
  "sync-payment-earnings",
  "release-earnings",
  // #1648 / #1654 — the email outbox relay; every 15 minutes, see TARGET_EVERY_MINUTES.
  "retry-failed-emails",
  // #1654 — the Novu outbox relay, every tick.
  "drain-notification-outbox",
  // #1583 E-P0-04 / #1589 P-P0-01, N-P1-03 / #1591 J1-P1-05 / #1599 C-P1-06 —
  // the booking sweeps whose hourly Actions twin let a lapsed pay-link, a
  // stale proposal, a missed reminder or a dead hold sit for ~100 minutes.
  // Every 15 minutes, see TARGET_EVERY_MINUTES; all five now READ `limit`
  // (#1583 P1) and carry an entry below.
  "expire-unpaid-trials",
  "reschedule-proposals",
  "appointment-reminders",
  "tentative-occurrences",
  "expire-stale-requests",
  // #1775 auto-complete / no-show detection. Both gate money: auto-complete
  // releases the earnings hold and opens feedback one hour after a session
  // ends, and the no-show detector issues a 100% refund. The docs previously
  // recorded their absence from this list as deliberate ("not
  // latency-sensitive"), on the reasoning that Actions was a sufficient
  // driver. That reasoning does not survive the code: ADR 22 measured Actions
  // delivering a sub-hourly schedule at roughly one delivery per hundred
  // minutes, so "an hourly Actions twin" is an unbounded upper bound and the
  // earnings release could sit ~100 minutes behind a session that ended. The
  // two are added here for the same reason as every other money sweep above —
  // not because the Actions run is insufficient, but because it is not a bound.
  "auto-complete-appointments",
  "detect-consultant-no-shows",
  // #1780 row 4 — refunds a cancelled class session nobody made up in 14 days.
  "settle-cancelled-sessions",
  // #1846 N2 — re-drives the auto-refunds the capture webhook tried once.
  "retry-auto-refunds",
  // #1859 M-P0-14 — SUCCEEDED with no appointment: the stranded-money cohort.
  // Read-only alert; the healer rides `reconcile-orphaned-payments`.
  "alert-orphaned-payments",
  // Heals the stranded cohort: links late appointments, refunds the rest.
  "reconcile-orphaned-payments",
  // #1868 — the Sentry ingest canary. The failure it detects is SILENT: Sentry
  // answers 200 for sessions and transactions while discarding error events
  // once the organisation's error allowance is spent, so nothing else in the
  // system notices. On 2026-09-22 that condition went live and the error
  // stream stayed empty for six days.
  //
  // It runs on a 30-minute slot, NOT this ticker's five-minute default, and the
  // reason is quota rather than latency: it posts a real stored event every run,
  // so five minutes is 8,640 events a month — 173% of the Developer plan's
  // 5,000 allowance, i.e. the health check would exhaust the budget it exists
  // to protect. 30 minutes is 1,440/month. See TARGET_EVERY_MINUTES, and
  // 06-ingest-canary.md. It costs one HTTPS round trip to a vendor and no
  // Redis, so unlike the other targets it has no per-tick lock cost to amortise.
  "sentry-ingest-canary",
  // Drains OrgDataExportJob (DPDP data export); every 10 minutes.
  "process-data-exports",
  // Drains StreamRevocationRetry and the VendorErasureRetry outbox (DPDP erasure); every 30 minutes.
  "retry-moderation-enforcement",
  // Vests or voids QUALIFYING referrals once the session is delivered and its refund window has passed.
  "vest-referral-credits",
] as const;

type Target = (typeof TARGETS)[number];

/** The batch size a target gets when it is not listed in {@link TARGET_LIMITS}. */
const DEFAULT_LIMIT = 50;

/**
 * #1459 — per-target overrides for the batch size. Fifty rows is only the right
 * bite for a sweep whose per-row cost is a database write; `abandoned-payments`
 * also makes a gateway round trip per payment, and at fifty it could not finish
 * inside {@link PER_TARGET_TIMEOUT_MS} on any tick.
 */
const TARGET_LIMITS: Partial<Record<Target, number | null>> = {
  "abandoned-payments": 10,
  // #1654 — paced at 8 sends/s plus a provider round trip each, twenty rows
  // fits its timeout.
  "retry-failed-emails": 20,
  // #1654 — one Novu round trip per row under a 5 s client timeout; twenty
  // rows stays inside the target timeout even when Novu is slow.
  "drain-notification-outbox": 20,
  // #1708 — one Stream round trip per unchanneled row; ten fits the 20 s budget.
  "reconcile-orphaned-confirmations": 10,
  // One Serializable transaction per referral; ten fit the 20 s budget.
  "vest-referral-credits": 10,
  // #1780 — a gateway refund per seat; ten sessions fit the 20 s budget.
  "settle-cancelled-sessions": 10,
  // #1846 N2 — a gateway refund per payment, same bite as the session sweep.
  "retry-auto-refunds": 10,
  // #1583 P1 — the five booking sweeps used to be appended `?limit=50` here and
  // ignored it, because their `run` callbacks took no request: every tick ran
  // the full Actions-sized cohort inside a 6 s or 20 s abort. They now read it,
  // and the bite is stated here so the ticker's own budget is a number in this
  // file rather than an accident of what a route happens to parse.
  //
  // Every one of the five is oldest-first (soonest-first for reminders) with a
  // per-run cap, no persisted cursor, and a write that removes the row from its
  // cohort — so a bite this size drains a backlog over successive ticks instead
  // of dropping the tail. `expire-stale-requests` is per-ARM, across seven arms.
  "appointment-reminders": 25,
  "expire-stale-requests": 20,
  "reschedule-proposals": 25,
  "tentative-occurrences": 200,
  "expire-unpaid-trials": 25,
  // #1775 — auto-complete judges each past session against a Stream call
  // report, and the no-show detector corroborates every candidate against a
  // Stream call report too, so both are network-bound per row rather than
  // database-bound. A small bite is what fits the 20 s tier; the Actions
  // hourly run drains the rest.
  "auto-complete-appointments": 25,
  "detect-consultant-no-shows": 10,
  // #1859 M-P0-14 — read-only scan, but one Sentry page per orphan row group;
  // same bite as the money sweeps so it fits the 20 s budget.
  "alert-orphaned-payments": 10,
  // Healer makes one gateway round trip per orphan; same bite fits 20 s.
  "reconcile-orphaned-payments": 10,
};

/**
 * #1654 — targets that run on a multiple of the five-minute tick. A missing
 * entry means every tick. The check is on the wall-clock minute, so a late
 * tick (Netlify fires within the minute) still counts as its slot.
 */
const TARGET_EVERY_MINUTES: Partial<Record<Target, number>> = {
  "sweep-stuck-webhook-events": 15,
  "sweep-orphaned-topup-captures": 15,
  "dispatch-outbound-webhooks": 15,
  "drain-notification-outbox": 10,
  "retry-failed-emails": 15,
  "sentry-ingest-canary": 30,
  "sync-payment-earnings": 15,
  "release-earnings": 15,
  "reconcile-refunds": 15,
  "abandoned-payments": 15,
  "reconcile-payment-status": 15,
  "reconcile-orphaned-confirmations": 15,
  "expire-unpaid-trials": 15,
  "reschedule-proposals": 15,
  "appointment-reminders": 15,
  "tentative-occurrences": 15,
  "expire-stale-requests": 15,
  "settle-cancelled-sessions": 15,
  "retry-auto-refunds": 15,
  // #1775 — 30 minutes, not 15. Both jobs are latency-relevant but not
  // minute-relevant: auto-complete's own buffer is one hour after a session
  // ends, so a 30-minute detection latency is well inside the window it has to
  // beat, and the no-show detector's grace window is measured in tens of
  // minutes. A 15-minute slot would double the Stream call-report volume for
  // both to buy detection latency neither deadline is sensitive to, and
  // #1792's Upstash budget is the direct line item.
  "auto-complete-appointments": 30,
  "detect-consultant-no-shows": 30,
  "alert-orphaned-payments": 15,
  "reconcile-orphaned-payments": 30,
  "process-data-exports": 10,
  "retry-moderation-enforcement": 30,
  // 30, not 15: only the :05/:35 ticks have room under the 8-target cap, and a vest waits hours anyway.
  "vest-referral-credits": 30,
};

/**
 * #1926 Action 6 — deterministic phase offsets (in minutes, modulo the
 * target's interval) so the 18 fifteen-minute targets, 1 ten-minute target,
 * and 4 thirty-minute targets spread evenly across the 5-minute slots instead
 * of firing all 23 targets simultaneously at `:00`/`:30` and 0 targets at
 * `:05`/`:25`/`:35`/`:55`. Every 5-minute tick now fires 7–8 targets.
 */
export const TARGET_OFFSET_MINUTES: Partial<Record<Target, number>> = {
  // Phase 0 (:00, :15, :30, :45) — 6 targets + sentry-ingest-canary (:00, :30)
  "sweep-stuck-webhook-events": 0,
  "sweep-orphaned-topup-captures": 0,
  "dispatch-outbound-webhooks": 0,
  "retry-failed-emails": 0,
  "sync-payment-earnings": 0,
  "sentry-ingest-canary": 0,
  // #1859 M-P0-14 — read-only orphan scan rides phase 0 so no tick exceeds 8.
  "alert-orphaned-payments": 0,
  // Phase 5 (:05, :20, :35, :50) — 6 targets + drain-notification-outbox (:05, :15, :25, :35, :45, :55)
  "release-earnings": 5,
  "reconcile-refunds": 5,
  "abandoned-payments": 5,
  "reconcile-payment-status": 5,
  "reconcile-orphaned-confirmations": 5,
  "expire-unpaid-trials": 5,
  "drain-notification-outbox": 5,
  // Phase 10 (:10, :25, :40, :55) — 6 targets + healer at :10/:40, Novu relay at :25/:55 (7 each)
  "reschedule-proposals": 10,
  "appointment-reminders": 10,
  "tentative-occurrences": 10,
  "expire-stale-requests": 10,
  "settle-cancelled-sessions": 10,
  "retry-auto-refunds": 10,
  // Thirty-minute session-outcome jobs and orphan healer on staggered slots
  "auto-complete-appointments": 15,
  "detect-consultant-no-shows": 20,
  "reconcile-orphaned-payments": 10,
  "process-data-exports": 0,
  "retry-moderation-enforcement": 25,
  "vest-referral-credits": 5,
};

/** The targets due on this tick; exported so a test can pin the cadence. */
export function dueTargets(now: Date): Target[] {
  const minute = now.getUTCMinutes();
  return TARGETS.filter((name) => {
    const every = TARGET_EVERY_MINUTES[name];
    if (every === undefined) return true;
    const offset = TARGET_OFFSET_MINUTES[name] ?? 0;
    return (((minute - offset) % every) + every) % every < 5;
  });
}

/** Extra query a target needs beyond `limit`. */
const TARGET_QUERIES: Partial<Record<Target, string>> = {};

/** Well under the 26 s Next function ceiling and the 30 s scheduled-function cap. */
const PER_TARGET_TIMEOUT_MS = 15_000;

/** 20 s still sits under the 30 s scheduled cap for gateway/outbox round-trip sweeps. */
const TARGET_TIMEOUTS_MS: Partial<Record<Target, number>> = {
  "abandoned-payments": 20_000,
  "retry-failed-emails": 20_000,
  "drain-notification-outbox": 20_000,
  "reconcile-orphaned-confirmations": 20_000,
  "appointment-reminders": 20_000,
  "expire-stale-requests": 20_000,
  // Per row: an appointment lock, a transaction, a slot restore and a notice.
  "reschedule-proposals": 20_000,
  "settle-cancelled-sessions": 20_000,
  "retry-auto-refunds": 20_000,
  "vest-referral-credits": 20_000,
  // One Stream call-report round trip per judged session or candidate.
  "auto-complete-appointments": 20_000,
  "detect-consultant-no-shows": 20_000,
  "alert-orphaned-payments": 20_000,
  "reconcile-orphaned-payments": 20_000,
  "process-data-exports": 20_000,
  "retry-moderation-enforcement": 20_000,
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
async function readResponseText(res: Response): Promise<string> {
  return typeof res.text === "function"
    ? await res.text().catch(() => "")
    : "";
}

async function parse503Response(
  res: Response,
): Promise<{ maintenance: boolean; errorBody?: string }> {
  const rawText = await readResponseText(res);
  let body: { phase?: unknown } | null = null;
  if (rawText) {
    try {
      body = JSON.parse(rawText) as { phase?: unknown };
    } catch {
      body = null;
    }
  } else if (typeof res.json === "function") {
    body = (await res.json().catch(() => null)) as {
      phase?: unknown;
    } | null;
  }
  const maintenance = typeof body?.phase === "string";
  return {
    maintenance,
    ...(!maintenance && rawText ? { errorBody: rawText.slice(0, 500) } : {}),
  };
}

async function hitTarget(
  baseUrl: string,
  secret: string,
  name: Target,
): Promise<{
  name: string;
  status: number;
  maintenance?: boolean;
  errorBody?: string;
}> {
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
    let errorBody: string | undefined;
    if (res.status === 503) {
      const parsed = await parse503Response(res);
      maintenance = parsed.maintenance;
      errorBody = parsed.errorBody;
    } else if (bucketFor(res.status, false) === "failed") {
      const rawText = await readResponseText(res);
      if (rawText) errorBody = rawText.slice(0, 500);
    }
    if (bucketFor(res.status, maintenance) === "failed" && errorBody) {
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
      maintenance,
      ...(errorBody ? { errorBody } : {}),
    };
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

/**
 * #1868 — which failed targets are reported to Sentry itself.
 *
 * The Sentry ingest canary is excluded. An unhealthy canary answers 503 with
 * no `phase`, so `bucketFor` files it under `failed`, and `alertFailedTargets`
 * reports to Sentry — the very system whose outage the canary just detected.
 * During a quota outage that is one event per tick that can never arrive; after
 * recovery, one more per tick spent from the allowance being protected. A
 * monitor that reports its own failure through the failing system is not a
 * monitor.
 *
 * The canary is still counted as failed: it stays in the HTTP status and the
 * response body, so a 503 remains visible in the tick's output and the job
 * history. Only the Sentry report is suppressed, and the email alert — which
 * fails open, so this same outage cannot silence it — carries the signal.
 */
export function reportableToSentry(name: string): boolean {
  return name !== "sentry-ingest-canary";
}

/** #1582 F-P2-02 — a missing secret is a silent fleet outage; page Sentry, not just the log. */
async function alertMissingSecret(error: string): Promise<void> {
  try {
    const Sentry = await import("@sentry/node");
    const { applyErrorBudget } = await import("../../sentry.shared.config");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      registerEsmLoaderHooks: false,
      beforeSend: applyErrorBudget,
    });
    Sentry.captureMessage(error, "fatal");
    await Sentry.flush(2_000);
  } catch (err) {
    console.error(JSON.stringify({ event: "cron-tick", sentry: String(err) }));
  }
}

/**
 * The Sentry event for one failing target. The target name is in the message
 * and fingerprint so the shared repeat filter and Sentry grouping are per target.
 */
export function buildFailedTargetEvent(failed: {
  name: string;
  status: number;
  errorBody?: string;
}) {
  return {
    message: `cron-tick: target ${failed.name} failed`,
    level: "error" as const,
    fingerprint: ["cron-tick", failed.name],
    tags: { subsystem: "cron", op: "cron-tick", target: failed.name },
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

const EVERY_BY_NAME: Partial<Record<string, number>> = TARGET_EVERY_MINUTES;
const OFFSET_BY_NAME: Partial<Record<string, number>> = TARGET_OFFSET_MINUTES;

/** A failing target reports at most once an hour: on its own first due tick of that hour. */
export function isFirstDueTickOfHour(name: string, now: Date): boolean {
  const every = EVERY_BY_NAME[name];
  const first =
    every === undefined
      ? 0
      : (((OFFSET_BY_NAME[name] ?? 0) % every) + every) % every;
  const sinceFirst = now.getUTCMinutes() - first;
  return sinceFirst >= 0 && sinceFirst < 5;
}

/**
 * Report each failing target to Sentry, once an hour per target. `statusFor`
 * answers 200 regardless, so without this a broken sweep only shows in the log;
 * a total outage is bounded by the shared 30/hour breaker.
 */
async function alertFailedTargets(
  failed: { name: string; status: number; errorBody?: string }[],
  tickStart: Date,
): Promise<void> {
  // Judge against the tick's start: targets can run 20 s past a minute boundary.
  const due = failed.filter((f) => isFirstDueTickOfHour(f.name, tickStart));
  if (due.length === 0) return;
  try {
    const Sentry = await import("@sentry/node");
    const { applyErrorBudget } = await import("../../sentry.shared.config");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0,
      tracePropagationTargets: [],
      registerEsmLoaderHooks: false,
      beforeSend: applyErrorBudget,
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
    for (const f of due) {
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
    const bucket = bucketFor(status, maintenance);
    if (bucket === "ok") ok.push(name);
    else if (bucket === "held") lockHeld.push(name);
    else {
      failed.push({ name, status });
      failedForAlert.push({
        name,
        status,
        ...(errorBody ? { errorBody } : {}),
      });
    }
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
  // #1868 — the Sentry ingest canary is deliberately NOT reported here. An
  // unhealthy canary answers 503 with no `phase`, so `bucketFor` files it
  // under `failed` — and `alertFailedTargets` reports failures to Sentry, which
  // is precisely the system whose outage the canary just detected. During a
  // quota outage that is one Sentry event per tick that can never arrive, and
  // after recovery one more per tick spent from the allowance we are trying to
  // protect. A monitor that reports its own failure through the failing system
  // is not a monitor. The email alert is the canary's channel, and it fails
  // open, so nothing is lost by excluding it here.
  //
  // It stays in `failed` for the HTTP status and the body, so a 503 from the
  // canary is still visible in the tick's own output and in the job-execution
  // history — only the Sentry report is suppressed.
  await alertFailedTargets(
    failedForAlert.filter((f) => reportableToSentry(f.name)),
    new Date(started),
  );

  // #1861 P4a — one heartbeat check-in per tick, sent after the targets so it
  // never delays them. Health follows `failed`, not the (always-200) HTTP
  // status; see statusFor's #1686 rationale for why the two diverge.
  await sendCheckIn(failed.length > 0 ? "error" : "ok", durationMs);

  // #1686 — 200 even with a non-empty `failed`; see statusFor.
  return jsonResponse(body, statusFor(failed));
}
