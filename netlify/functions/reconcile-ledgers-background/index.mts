/**
 * Netlify Background Function (#1454) — the `-background` suffix gives it an
 * immediate 202, a 15-minute limit and two automatic retries. It advances one
 * ledger reconcile run through the CRON_SECRET-gated twin at
 * `/api/cleanup/reconcile-ledgers` in bounded chunks; progress lives on the
 * report row, so a retry resumes. Docs: docs/maintenance/04-cron-jobs-reference.md.
 * Self-contained like `cron-tick.mts`: `process.env`, global `fetch`, Web Crypto,
 * and the pure loop in the sibling `drive.ts` — nothing outside this directory.
 */

import { driveReconcileRun } from "./drive.ts";

/** Rows per chunk unless RECONCILE_DRIVER_LIMIT or the kick overrides it. */
const DEFAULT_LIMIT = 100;
/** Under the 15-minute background limit with room for the final chunk and its retry. */
const BUDGET_MS = 13 * 60 * 1000;
const MAX_CALLS = 400;
/** Above the ~26 s edge cut so a slow chunk is reported by the edge, not aborted early. */
const PER_CALL_TIMEOUT_MS = 40_000;
/** 12 × 10 s outlasts the 90 s chunk-lock TTL a killed chunk can leave behind. */
const MAX_CONSECUTIVE_RETRIES = 12;
const RETRY_DELAY_MS = 10_000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "reconcile-driver", ...record }));
}

/** Constant-time bearer check over SHA-256 digests, as lib/cron/cleanup-route.ts does. */
async function bearerMatches(
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const digest = async (v: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    );
  const [a, b] = await Promise.all([
    digest(header),
    digest(`Bearer ${secret}`),
  ]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * `CONTEXT` is not visible at function runtime (serverless-gotchas.md), so the
 * preview-vs-production choice is DEPLOY_PRIME_URL: this deploy's own origin
 * on a preview, and the site's netlify.app origin on production.
 */
function resolveBaseUrl(): string {
  let baseUrl =
    process.env.CRON_TICK_BASE_URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.URL ||
    "";
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return baseUrl;
}

interface KickParams {
  runId?: string;
  limit?: number;
  triggeredById?: string;
}

/** The kick's parameters, from the JSON body with the query string as a fallback. */
async function readKick(req: Request): Promise<KickParams & { from: string }> {
  const query = new URL(req.url).searchParams;
  const body = (await req.json().catch(() => ({}))) as KickParams;
  const runId = body.runId ?? query.get("runId") ?? undefined;
  const limitRaw = body.limit ?? Number(query.get("limit"));
  const limit =
    Number.isInteger(limitRaw) && (limitRaw as number) > 0
      ? (limitRaw as number)
      : undefined;
  return {
    runId,
    limit,
    triggeredById:
      body.triggeredById ?? query.get("triggeredById") ?? undefined,
    from: body.runId ? "body" : query.get("runId") ? "query" : "none",
  };
}

export default async function reconcileLedgersBackground(
  req: Request,
): Promise<Response> {
  // First statement, before any await: a driver that answers 202 and does
  // nothing must at least leave this line in the function log.
  const secret = process.env.CRON_SECRET;
  const baseUrl = resolveBaseUrl();
  const authHeader = req.headers.get("authorization");
  log({
    phase: "start",
    method: req.method,
    url: req.url,
    baseUrl,
    hasSecret: Boolean(secret),
    hasAuthHeader: authHeader !== null,
  });

  const kick = await readKick(req);
  log({
    phase: "params",
    runId: kick.runId ?? null,
    limit: kick.limit ?? null,
    paramsFrom: kick.from,
  });
  if (!secret) {
    const error = "CRON_SECRET is not set — the driver cannot authenticate";
    console.error(JSON.stringify({ event: "reconcile-driver", error }));
    return jsonResponse({ error }, 500);
  }
  if (!(await bearerMatches(authHeader, secret))) {
    log({ phase: "end", outcome: "UNAUTHORIZED" });
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!kick.runId) {
    log({ phase: "end", outcome: "NO_RUN_ID" });
    return jsonResponse({ error: "runId is required" }, 400);
  }
  const envLimit = Number(process.env.RECONCILE_DRIVER_LIMIT);
  const limit =
    kick.limit ??
    (Number.isInteger(envLimit) && envLimit > 0 ? envLimit : DEFAULT_LIMIT);

  const result = await driveReconcileRun({
    fetchImpl: (url, init) => fetch(url, init),
    sleep,
    baseUrl,
    secret,
    runId: kick.runId,
    limit,
    triggeredById: kick.triggeredById,
    budgetMs: BUDGET_MS,
    maxCalls: MAX_CALLS,
    perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
    maxConsecutiveRetries: MAX_CONSECUTIVE_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
  });
  log({ phase: "end", limit, ...result });

  if (result.outcome === "COMPLETED" || result.outcome === "FAILED") {
    return jsonResponse(result, 200);
  }
  // A non-retryable answer from the twin (404, 500, ...) will not heal on a
  // retry, so the row is closed as FAILED with the reason instead of sitting
  // RUNNING until the stale window. The twin does the write; the driver has
  // no Prisma.
  if (result.outcome === "ERROR") {
    const reason = `driver gave up: ${result.outcome} after ${result.calls} calls (last status ${result.lastStatus})`;
    const abandon = await fetch(
      `${baseUrl}/api/cleanup/reconcile-ledgers?runId=${encodeURIComponent(result.runId)}&abandon=${encodeURIComponent(reason)}`,
      { method: "POST", headers: { Authorization: `Bearer ${secret}` } },
    ).catch(() => null);
    log({
      phase: "abandon",
      runId: result.runId,
      status: abandon?.status ?? 0,
    });
    return jsonResponse(result, 200);
  }
  // Budget, call cap or transient answers exhausted: throwing is what makes
  // Netlify retry (after 1 min, then 2), and the retry resumes from the row.
  throw new Error(
    `reconcile run ${result.runId} not finished: ${result.outcome} after ${result.calls} calls (last status ${result.lastStatus})`,
  );
}
