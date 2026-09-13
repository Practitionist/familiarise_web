/**
 * Netlify Background Function (#1454) — the `-background` suffix gives it an
 * immediate 202, a 15-minute limit and two automatic retries. It advances one
 * ledger reconcile run through the CRON_SECRET-gated twin at
 * `/api/cleanup/reconcile-ledgers` in bounded chunks; progress lives on the
 * report row, so a retry resumes. Docs: docs/maintenance/04-cron-jobs-reference.md.
 * Dependency-free like `cron-tick.mts`: `process.env`, global `fetch`, one pure loop.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { driveReconcileRun } from "../../lib/reconcile/drive-reconcile-run";

/** Rows per chunk unless RECONCILE_DRIVER_LIMIT or the kick body overrides it. */
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

/** Constant-time bearer check, the same shape as lib/cron/cleanup-route.ts. */
function bearerMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const sha = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(sha(header), sha(`Bearer ${secret}`));
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

function log(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "reconcile-driver", ...record }));
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
  const secret = process.env.CRON_SECRET;
  const baseUrl = resolveBaseUrl();
  const kick = await readKick(req);
  const authHeader = req.headers.get("authorization");
  log({
    phase: "start",
    runId: kick.runId ?? null,
    limit: kick.limit ?? null,
    paramsFrom: kick.from,
    baseUrl,
    hasSecret: Boolean(secret),
    hasAuthHeader: authHeader !== null,
    method: req.method,
  });
  if (!secret) {
    const error = "CRON_SECRET is not set — the driver cannot authenticate";
    console.error(JSON.stringify({ event: "reconcile-driver", error }));
    return jsonResponse({ error }, 500);
  }
  if (!bearerMatches(authHeader, secret)) {
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
