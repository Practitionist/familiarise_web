/**
 * #1454 — the loop behind `netlify/functions/reconcile-ledgers-background.mts`.
 *
 * Advances one ledger reconcile run by POSTing bounded chunks to the job's
 * HTTP twin until the twin reports the run COMPLETED or FAILED, or the driver's
 * own budget is spent. Pure on purpose: no imports, `fetch` and `sleep` are
 * injected, so the Netlify function stays dependency-free and the loop can be
 * pinned by a test. Rationale: docs/maintenance/04-cron-jobs-reference.md.
 */

export type DriveOutcome =
  | "COMPLETED"
  | "FAILED"
  | "BUDGET_EXHAUSTED"
  | "CALL_CAP_REACHED"
  | "RETRIES_EXHAUSTED"
  | "ERROR";

export interface DriveResult {
  runId: string;
  outcome: DriveOutcome;
  /** Chunk calls the twin accepted (2xx). */
  calls: number;
  /** Calls answered 409 (lock held), 502/503/504 (edge or upstream) or 0 (network). */
  retried: number;
  lastStatus: number;
  durationMs: number;
}

export interface DriveOptions {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  baseUrl: string;
  secret: string;
  runId: string;
  /** `?limit=` for every chunk call. */
  limit: number;
  /** Threaded to the twin so the report row names the admin who kicked it. */
  triggeredById?: string;
  /** Wall-clock ceiling for the whole loop; keep under the 15-minute function limit. */
  budgetMs: number;
  /** Hard cap on chunk calls, independent of the budget. */
  maxCalls: number;
  /** Abort one chunk call after this long; the row keeps whatever the call saved. */
  perCallTimeoutMs: number;
  /** Consecutive non-2xx answers tolerated before giving up. */
  maxConsecutiveRetries: number;
  retryDelayMs: number;
  now?: () => number;
}

/** Answers that mean "try the same call again shortly", not "the run is broken". */
const RETRYABLE = new Set([0, 409, 502, 503, 504]);

interface TwinBody {
  status?: "RUNNING" | "COMPLETED" | "FAILED";
}

export async function driveReconcileRun(
  opts: DriveOptions,
): Promise<DriveResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const params = new URLSearchParams({
    runId: opts.runId,
    limit: String(opts.limit),
  });
  if (opts.triggeredById) params.set("triggeredById", opts.triggeredById);
  const url = `${opts.baseUrl}/api/cleanup/reconcile-ledgers?${params}`;

  let calls = 0;
  let retried = 0;
  let consecutive = 0;
  let lastStatus = 0;
  const done = (outcome: DriveOutcome): DriveResult => ({
    runId: opts.runId,
    outcome,
    calls,
    retried,
    lastStatus,
    durationMs: now() - started,
  });

  while (calls < opts.maxCalls) {
    if (now() - started >= opts.budgetMs) return done("BUDGET_EXHAUSTED");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.perCallTimeoutMs);
    let status = 0;
    let body: TwinBody = {};
    try {
      const res = await opts.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.secret}` },
        signal: controller.signal,
      });
      status = res.status;
      if (status >= 200 && status < 300) {
        body = (await res.json().catch(() => ({}))) as TwinBody;
      }
    } catch {
      status = 0;
    } finally {
      clearTimeout(timer);
    }
    lastStatus = status;

    if (status >= 200 && status < 300) {
      calls += 1;
      consecutive = 0;
      if (body.status === "COMPLETED") return done("COMPLETED");
      if (body.status === "FAILED") return done("FAILED");
      continue;
    }
    if (RETRYABLE.has(status)) {
      retried += 1;
      consecutive += 1;
      if (consecutive > opts.maxConsecutiveRetries) {
        return done("RETRIES_EXHAUSTED");
      }
      await opts.sleep(opts.retryDelayMs);
      continue;
    }
    return done("ERROR");
  }
  return done("CALL_CAP_REACHED");
}
