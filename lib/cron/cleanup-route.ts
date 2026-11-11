import { createHash, timingSafeEqual } from "node:crypto";
// Native Node ESM workers require the explicit package file extension.
import { NextResponse, type NextRequest } from "next/server.js";
import * as Sentry from "@sentry/core";
import { z } from "zod";
import {
  hasItemFailures,
  jobOutcome,
  type JobOutcome,
} from "@/lib/cron/job-outcome";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/with-cron-lock";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
  MaintenanceUnavailableError,
} from "@/lib/maintenance-cron";
import { isPoolExhaustion } from "@/lib/db/pg-errors";
import {
  currentRun,
  noteCounter,
  schedulerTrigger,
  withRunContext,
} from "@/lib/cron/run-context";
import {
  routeOutcome,
  type RunItemCounts,
  type RunOutcome,
} from "@/lib/cron/run-outcome";
import { recordRouteRun, type RouteRunRecord } from "@/lib/cron/run-record";
import {
  JobRunRefusedError,
  jobsMayRunHere,
  ProductionOnlyRefusal,
} from "@/lib/cron/dispatch-refusal";

/**
 * The one result→status mapping the whole cohort shares. Failure is tested
 * FIRST on purpose: the previous per-route ternaries asked "is anything
 * flagged?" before "did the run succeed?", so a run that both failed and found
 * a flagged row answered 207 — a 2xx, which reads as healthy to anything
 * watching the status. That is the same masking PM-34 removed from the refund
 * cascade.
 *
 * @param needsAttention A route-specific counter that means "succeeded, but an
 *   operator has to look" — a discrepancy, a double booking, a dispute that was
 *   already paid.
 */
export function statusFor(result: unknown, needsAttention = false): number {
  const outcome = jobOutcome(result);
  if (outcome === "failure") return 500;
  if (outcome === "held") return 503;
  return needsAttention || outcome === "partial_failure" ? 207 : 200;
}

/** Outcome for an explicit per-job status; a 207 stays "success" so the ticker's 207 allowlist decides. */
function outcomeOfStatus(httpStatus: number): JobOutcome {
  return httpStatus >= 400 ? "failure" : "success";
}

/** Ceiling on an explicit `?limit=`; above this it is clamped, not rejected. */
const LIMIT_CAP = 500;

/** Longer than the slowest ticker cadence, so a job failing every run reports at most hourly per instance. */
const CRON_FAILURE_REPORT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Thrown by {@link parseLimitParam} for a `?limit=` that is present but not a
 * positive integer, so `cleanupRoute` can answer 400 instead of the caller
 * silently falling through to an unbounded run — the failure mode a malformed
 * ticker request would otherwise hit.
 */
export class InvalidLimitError extends Error {
  constructor() {
    super("INVALID_LIMIT");
    this.name = "InvalidLimitError";
  }
}

/**
 * Optional `?limit=` cap shared by the routes the Netlify ticker drives every
 * five minutes (#1356, ADR 27 — docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
 * A five-minute tick has to fit inside the ticker's per-target timeout, unlike
 * the nightly GitHub Actions run, which can afford an unbounded batch — so the
 * ticker sends `?limit=50` and every other caller (Actions, manual `curl`)
 * omits it and keeps today's unbounded behaviour. A present-but-invalid value
 * (empty, non-numeric, zero, negative, or fractional) throws
 * {@link InvalidLimitError} rather than being treated as absent; a value above
 * the cap is clamped to it.
 */
export function parseLimitParam(req: NextRequest): number | undefined {
  const raw = req.nextUrl.searchParams.get("limit");
  // #1459 — only a missing key is absent. A truthiness test also swallowed
  // `?limit=`, which is a caller that meant to bound the sweep and sent
  // nothing: it would have got the unbounded batch back, the exact silent
  // fall-through this parser exists to make visible.
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidLimitError();
  }
  return Math.min(n, LIMIT_CAP);
}

/**
 * {@link parseLimitParam} with a floor, for the routes the Netlify ticker
 * drives whose core work is per-row.
 *
 * The distinction from the bare parser is the DEFAULT. A route whose `run`
 * ignores the request entirely (its core takes no arguments) silently runs its
 * unbounded cohort inside the ticker's abort — the failure this exists to
 * close. Giving such a route a fallback means every caller is bounded, and
 * `?limit=` can only tighten that bound, never remove it.
 *
 * The fallback belongs HERE rather than at the ticker, because the ticker is
 * not the only caller: a hand-rolled `curl` with `CRON_SECRET`, an operator
 * probe, and a future scheduler all reach the same route, and a limit enforced
 * only by one caller is a limit that silently disappears with it.
 */
export function parseLimitParamOrDefault(
  req: NextRequest,
  fallback: number,
): number {
  return parseLimitParam(req) ?? fallback;
}

/** Thrown by {@link parseWindowStartParam} for a `?windowStart=` that is not an ISO instant in the past. */
export class InvalidWindowStartError extends Error {
  constructor() {
    super("INVALID_WINDOW_START");
    this.name = "InvalidWindowStartError";
  }
}

const windowStartSchema = z.string().datetime();

/**
 * The calendar window start the ticker sends with a windowed target; a slice
 * treats its cohort as of this instant. Absent for manual callers.
 */
export function parseWindowStartParam(req: NextRequest): Date | undefined {
  const raw = req.nextUrl.searchParams.get("windowStart");
  if (raw === null) return undefined;
  const parsed = windowStartSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidWindowStartError();
  const at = new Date(parsed.data);
  if (at.getTime() > Date.now()) throw new InvalidWindowStartError();
  return at;
}

/** Thrown by the GST and TDS period parsers for a malformed `?period=`, `?fy=` or `?quarter=`. */
export class InvalidPeriodParamError extends Error {
  constructor() {
    super("INVALID_PERIOD");
    this.name = "InvalidPeriodParamError";
  }
}

const gstPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Optional `?period=YYYY-MM` for the GST outward-register export. */
export function parseGstPeriodParam(req: NextRequest): string | undefined {
  const raw = req.nextUrl.searchParams.get("period");
  if (raw === null) return undefined;
  const parsed = gstPeriodSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidPeriodParamError();
  return parsed.data;
}

const tdsReturnParamsSchema = z.object({
  fy: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .refine(
      (fy) => (Number(fy.slice(0, 4)) + 1) % 100 === Number(fy.slice(5)),
      "fy must name consecutive years",
    )
    .optional(),
  quarter: z.coerce.number().int().min(1).max(4).optional(),
});

/** Optional `?fy=YYYY-YY` and `?quarter=1..4` for the TDS return draft; each defaults to the closed quarter. */
export function parseTdsReturnParams(req: NextRequest): {
  financialYear?: string;
  quarter?: number;
} {
  const { searchParams } = req.nextUrl;
  const parsed = tdsReturnParamsSchema.safeParse({
    fy: searchParams.get("fy") ?? undefined,
    quarter: searchParams.get("quarter") ?? undefined,
  });
  if (!parsed.success) throw new InvalidPeriodParamError();
  return { financialYear: parsed.data.fy, quarter: parsed.data.quarter };
}

const deleteFlagSchema = z.literal("1");

/** `?delete=1` opts a count-only job into deleting; anything else leaves it counting. */
export function parseDeleteFlag(req: NextRequest): boolean {
  return deleteFlagSchema.safeParse(req.nextUrl.searchParams.get("delete"))
    .success;
}

/**
 * Constant-time bearer comparison. Digesting first keeps both operands the
 * same fixed length, so neither the secret's length nor its matching prefix is
 * observable through response timing.
 *
 * Exported because four `app/api/cleanup/*` routes predate the factory and
 * hand-roll their own HTTP twin. `reconcile-sessions` compared the header with
 * `!==`, which leaks the matching prefix through timing; the others duplicated
 * this correctly. One implementation, so the next hand-rolled twin cannot get
 * it subtly wrong.
 */
export function bearerMatches(
  authHeader: string | null,
  cronSecret: string,
): boolean {
  if (!authHeader) return false;
  const sha = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(sha(authHeader), sha(`Bearer ${cronSecret}`));
}

function ingestCanaryEnabled(job: string): boolean {
  const raw = process.env.SENTRY_INGEST_CANARY_JOBS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(job);
}

interface CleanupExecutionResult {
  body: unknown;
  status: number;
  ok: boolean;
  outcome: JobOutcome;
  /** The outcome recorded on the run row; absent when the caller was refused before running. */
  runOutcome?: RunOutcome;
}

type RunVerdict = Omit<RouteRunRecord, "jobName" | "httpStatus">;

/** How a thrown run is recorded; null leaves no row (a lease the database could not grant). */
function verdictOfError(error: unknown): RunVerdict | null {
  if (error instanceof CronLockHeldError) {
    return {
      outcome: "held",
      reason: "lock-held",
      holderRunId: error.holderRunId,
    };
  }
  if (error instanceof CronLockUnavailableError) return null;
  if (error instanceof MaintenanceActiveError) {
    return { outcome: "refused", reason: `maintenance:${error.phase}` };
  }
  if (error instanceof MaintenanceUnavailableError) {
    return { outcome: "refused", reason: "maintenance-state-unreadable" };
  }
  if (error instanceof ProductionOnlyRefusal) {
    return { outcome: "refused", reason: error.reason };
  }
  return {
    outcome: "failed",
    reason: error instanceof Error ? error.name : "thrown",
  };
}

const tickIdSchema = z.string().uuid();
const runTriggerSchema = z.string().regex(/^(cron|admin:[A-Za-z0-9_-]+)$/);

/** The ticker's per-tick id, when the caller is the ticker. */
function tickIdOf(req: NextRequest): string | undefined {
  const parsed = tickIdSchema.safeParse(req.headers.get("x-tick-id"));
  return parsed.success ? parsed.data : undefined;
}

export interface CleanupRouteHandlers {
  GET: (req: NextRequest) => Promise<NextResponse>;
  POST: (req: NextRequest) => Promise<NextResponse>;
  /** The job name the route gates and records under. */
  job: string;
  /** The same run without the bearer check, for the authenticated admin door in-process. */
  invoke: (req: NextRequest) => Promise<NextResponse>;
}

function cleanupFailure(
  error: unknown,
  job: string,
  failureMessage?: string,
): CleanupExecutionResult {
  if (error instanceof CronLockHeldError) {
    return {
      body: { error: error.message },
      status: 409,
      ok: true,
      outcome: "held",
    };
  }
  // Shared acquisition failures report once per instance and window across jobs.
  if (error instanceof CronLockUnavailableError) {
    captureThrottled(
      "cron:lock-unavailable",
      error,
      {
        subsystem: "cron",
        op: "lock-unavailable",
        expected: true,
        level: "warning",
        tags: { job },
      },
      CRON_FAILURE_REPORT_WINDOW_MS,
    );
    // The ticker counts this code in its summary line, the only record a refused lease leaves.
    return {
      body: { error: error.message, code: error.code },
      status: 503,
      ok: false,
      outcome: "failure",
    };
  }
  // Each message is its 400 error code.
  if (
    error instanceof InvalidLimitError ||
    error instanceof InvalidWindowStartError ||
    error instanceof InvalidPeriodParamError
  ) {
    return {
      body: { error: error.message },
      status: 400,
      ok: true,
      outcome: "failure",
    };
  }
  if (error instanceof MaintenanceUnavailableError) {
    return {
      body: { error: error.message, code: "MAINTENANCE_STATE_UNREADABLE" },
      status: 503,
      ok: false,
      outcome: "failure",
    };
  }
  if (error instanceof MaintenanceActiveError) {
    return {
      body: { error: error.message, phase: error.phase },
      status: error.httpStatus,
      ok: true,
      outcome: "held",
    };
  }
  if (error instanceof ProductionOnlyRefusal) {
    return {
      body: { error: error.message, code: error.code },
      status: error.httpStatus,
      ok: true,
      outcome: "held",
    };
  }
  // Keep exception details in telemetry; the HTTP body exposes only a stable message.
  captureThrottled(
    `cron:${job}`,
    error,
    { subsystem: "cron", tags: { job } },
    CRON_FAILURE_REPORT_WINDOW_MS,
  );
  console.error(`Error in ${job}:`, error);
  return {
    body: { error: failureMessage ?? `Failed to run ${job}` },
    status: 500,
    ok: false,
    outcome: "failure",
  };
}

/** Null when the bearer is valid (naming the trigger on the active run); else the 401 result. */
function refuseUnauthorized(
  req: NextRequest,
  job: string,
  unauthorizedMessage: string | undefined,
): CleanupExecutionResult | null {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !bearerMatches(authHeader, cronSecret)) {
    console.warn(`Unauthorized ${job} attempt`);
    return {
      body: unauthorizedMessage
        ? { error: "Unauthorized", message: unauthorizedMessage }
        : { error: "Unauthorized" },
      status: 401,
      ok: true,
      outcome: "failure",
    };
  }
  // An authenticated dispatcher (the admin door's background hop) names the trigger.
  const trigger = runTriggerSchema.safeParse(req.headers.get("x-run-trigger"));
  const active = currentRun();
  if (trigger.success && active) active.triggeredBy = trigger.data;
  return null;
}

/** A 207 raised only by the needs-attention flag, with no item failing. */
function isFindingsOnly(
  result: object,
  summary: object,
  flagged: boolean,
): boolean {
  return (
    flagged &&
    jobOutcome(result) === "success" &&
    !hasItemFailures(result) &&
    !hasItemFailures(summary)
  );
}

/**
 * Every job under `app/api/cleanup/*` needs the same HTTP twin: a
 * CRON_SECRET bearer check, an off-production refusal (`jobsMayRunHere`), a
 * maintenance-phase guard, structured start/finish
 * logging, and a three-way error mapping (lock held → 409, maintenance active
 * → its own status, anything else → captured + 500). Before this factory that
 * ~75-line shape was hand-copied into 40+ route files, which is what SonarCloud
 * flagged as duplication — one job's guard bug would only ever get fixed in
 * the file someone happened to be looking at. Centralizing it means the guard
 * has exactly one place to be correct, and a route only differs by the one
 * thing that is actually route-specific: what it runs and how it maps the
 * result to a status code.
 */
export function cleanupRoute<T extends object>(
  opts: {
    /** Job name — feeds `assertNotInMaintenance`, the Sentry logger key, and the tag. */
    job: string;
    /** `startedAt` is when the request reached the route, for a sweep's drain deadline. */
    run: (req: NextRequest, ctx: { startedAt: number }) => Promise<T>;
    /** What to log on finish; defaults to the whole result. */
    summarize?: (result: T) => Record<string, unknown>;
    /** Item and error counts for the run row; wins over the generic summary-key extractor. */
    items?: (result: T) => RunItemCounts;
    failureMessage?: string;
    /** Extra `message` field on the 401 body, for routes that carry one. */
    unauthorizedMessage?: string;
  } & (
    | {
        /** Authoritative when present; a 207 from it is recorded as partial. */
        status?: (result: T) => number;
        needsAttention?: never;
      }
    | {
        /** Findings that answer 207 through {@link statusFor}; with no item failing the run is recorded as attention. */
        needsAttention: (result: T) => boolean;
        status?: never;
      }
  ),
): CleanupRouteHandlers {
  const {
    job,
    run,
    summarize,
    items,
    status,
    needsAttention,
    failureMessage,
    unauthorizedMessage,
  } = opts;

  async function executeCleanupJob(
    req: NextRequest,
    authorize: boolean,
  ): Promise<CleanupExecutionResult> {
    const startedAt = Date.now();
    try {
      if (authorize) {
        const refused = refuseUnauthorized(req, job, unauthorizedMessage);
        if (refused) return refused;
      }
      if (!jobsMayRunHere()) throw new JobRunRefusedError(job);
      // The cron core is shared with the jobs/** entrypoint, which exits on
      // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
      await assertNotInMaintenance(job);

      console.log(`Starting ${job} via API...`);
      Sentry.logger.info(`cron:${job} started`);

      const result = await run(req, { startedAt });
      const summary = summarize?.(result) ?? result;

      console.log(`${job} completed:`, summary);
      Sentry.logger.info(
        `cron:${job} finished`,
        Object.fromEntries(Object.entries(summary)),
      );

      // An explicit per-job mapping is authoritative, so the outcome header follows its status.
      const flagged = needsAttention?.(result) ?? false;
      const responseStatus = status
        ? status(result)
        : statusFor(result, flagged);
      const verdict = routeOutcome(
        result,
        responseStatus,
        isFindingsOnly(result, summary, flagged),
      );
      await record({
        ...verdict,
        httpStatus: responseStatus,
        summary,
        items: items?.(result),
      });
      return {
        body: result,
        status: responseStatus,
        ok: responseStatus < 500,
        outcome: status ? outcomeOfStatus(responseStatus) : jobOutcome(result),
        runOutcome: verdict.outcome,
      };
    } catch (error) {
      if (isPoolExhaustion(error)) noteCounter("poolTimeout");
      const failure = cleanupFailure(error, job, failureMessage);
      const verdict = verdictOfError(error);
      // A held row carries the lock's own name, which a route core may spell differently.
      const lockJob = error instanceof CronLockHeldError ? error.jobName : job;
      if (verdict)
        await record({ ...verdict, httpStatus: failure.status }, lockJob);
      return { ...failure, runOutcome: verdict?.outcome ?? "failed" };
    }
  }

  async function record(
    verdict: Omit<RouteRunRecord, "jobName">,
    jobName = job,
  ): Promise<void> {
    const active = currentRun();
    if (active) await recordRouteRun(active, { ...verdict, jobName });
  }

  async function respond(
    req: NextRequest,
    authorize: boolean,
  ): Promise<NextResponse> {
    const outer = currentRun();
    return withRunContext(
      {
        triggeredBy: outer?.triggeredBy ?? schedulerTrigger(),
        tickId: outer?.tickId ?? tickIdOf(req),
        opsActionLogId: outer?.opsActionLogId,
      },
      async () => {
        const canary = ingestCanaryEnabled(job);
        const outcome = await executeCleanupJob(req, authorize);
        if (canary || !outcome.ok) {
          await Sentry.flush(2_000);
        }
        return NextResponse.json(outcome.body, {
          status: outcome.status,
          headers: {
            "X-Job-Outcome": outcome.outcome,
            ...(outcome.runOutcome
              ? { "X-Run-Outcome": outcome.runOutcome }
              : {}),
          },
        });
      },
    );
  }

  const handle = (req: NextRequest) => respond(req, true);
  return {
    GET: handle,
    POST: handle,
    job,
    invoke: (req: NextRequest) => respond(req, false),
  };
}
