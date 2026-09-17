/**
 * Netlify scheduled ticker — ADR 27 (docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
 *
 * ADR 22 measured GitHub Actions delivering a sub-hourly `cron:` schedule
 * roughly once every hundred minutes (#866), so the fleet's money sweeps were
 * running six times slower than their declared cadence. This function POSTs
 * the latency-sensitive `/api/cleanup/*` routes every five minutes (ten money
 * sweeps, since #1633 the ledger reconcile backstop and, since #1654, the
 * Novu outbox relay every tick and the email outbox relay on every third
 * tick) instead of waiting on Actions. It never writes money state itself: every
 * target is `CRON_SECRET`-gated and wraps its core in `withCronLock`, so a
 * tick that overlaps a GitHub Actions run (or another tick) answers 409 from
 * the loser — expected, not an error — and Actions stays as the unbounded
 * daily/weekly scheduler and backstop (#1356).
 *
 * Deliberately dependency-free: no `@netlify/functions` import, only
 * `process.env` and the global `fetch`/`AbortController` the Netlify
 * Functions runtime already provides.
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
};

/**
 * #1654 — targets that run on a multiple of the five-minute tick. A missing
 * entry means every tick. The check is on the wall-clock minute, so a late
 * tick (Netlify fires within the minute) still counts as its slot.
 */
const TARGET_EVERY_MINUTES: Partial<Record<Target, number>> = {
  "retry-failed-emails": 15,
  // #1686 — six sweeps whose Actions twin already tolerates 15 min; a 5 min
  // tick on twelve targets was a cold burst billed as duration (ticket #1112198).
  "reconcile-ledgers": 15,
  "sync-payment-earnings": 15,
  "release-earnings": 15,
  "cascade-refund-earnings": 15,
  "reconcile-refunds": 15,
  "abandoned-payments": 15,
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
): Promise<{ name: string; status: number }> {
  const { url, timeoutMs } = targetRequest(baseUrl, name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    return { name, status: res.status };
  } catch {
    return { name, status: 0 };
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
    return jsonResponse({ error }, 500);
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
    if (status === 200 || status === 207) ok.push(name);
    else if (status === 409) lockHeld.push(name);
    else failed.push({ name, status });
  });

  const body: TickBody = {
    event: "cron-tick",
    ok,
    lockHeld,
    failed,
    durationMs: Date.now() - started,
  };
  console.log(JSON.stringify(body));

  // #1390 review — a 200 here reads as a healthy invocation to Netlify's
  // function metrics/retries even when a target failed; failed sweeps still
  // get picked up by the Actions backstop, but the tick itself should not
  // self-report healthy.
  return jsonResponse(body, failed.length > 0 ? 500 : 200);
}
