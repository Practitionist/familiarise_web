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

/** Same resolution as lib/url.ts: a preview must drive its own twin, not production's. */
function resolveBaseUrl(): string {
  const preview =
    process.env.CONTEXT && process.env.CONTEXT !== "production"
      ? process.env.DEPLOY_PRIME_URL
      : undefined;
  let baseUrl =
    process.env.CRON_TICK_BASE_URL || preview || process.env.URL || "";
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return baseUrl;
}

export default async function reconcileLedgersBackground(
  req: Request,
): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    const error = "CRON_SECRET is not set — the driver cannot authenticate";
    console.error(JSON.stringify({ event: "reconcile-driver", error }));
    return jsonResponse({ error }, 500);
  }
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    limit?: number;
    triggeredById?: string;
  };
  if (typeof body.runId !== "string" || body.runId.length === 0) {
    return jsonResponse({ error: "runId is required" }, 400);
  }
  const envLimit = Number(process.env.RECONCILE_DRIVER_LIMIT);
  const limit =
    Number.isInteger(body.limit) && (body.limit as number) > 0
      ? (body.limit as number)
      : Number.isInteger(envLimit) && envLimit > 0
        ? envLimit
        : DEFAULT_LIMIT;

  const result = await driveReconcileRun({
    fetchImpl: (url, init) => fetch(url, init),
    sleep,
    baseUrl: resolveBaseUrl(),
    secret,
    runId: body.runId,
    limit,
    triggeredById: body.triggeredById,
    budgetMs: BUDGET_MS,
    maxCalls: MAX_CALLS,
    perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
    maxConsecutiveRetries: MAX_CONSECUTIVE_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
  });
  console.log(JSON.stringify({ event: "reconcile-driver", limit, ...result }));

  // Anything short of a terminal row state is a failed invocation: throwing is
  // what makes Netlify retry (after 1 min, then 2), and the retry resumes.
  if (result.outcome !== "COMPLETED" && result.outcome !== "FAILED") {
    throw new Error(
      `reconcile run ${result.runId} not finished: ${result.outcome} after ${result.calls} calls (last status ${result.lastStatus})`,
    );
  }
  return jsonResponse(result, 200);
}
