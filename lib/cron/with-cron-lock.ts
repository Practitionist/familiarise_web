import * as Sentry from "@sentry/core";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/cron-lock-errors";
import { isPoolExhaustion, isUniqueViolation } from "@/lib/db/pg-errors";
import { jobOutcome, type JobOutcome } from "@/lib/cron/job-outcome";

// Postgres leases prevent overlap; each worker must independently tolerate replay.

export { CronLockHeldError, CronLockUnavailableError };

const DEFAULT_TTL_MS = 15 * 60 * 1000; // workflows set timeout-minutes: 10
/** Payout/reconcile family runs up to 30 min (ADR 05) — lock must outlive it. */
export const LONG_JOB_TTL_MS = 35 * 60 * 1000;

export interface CronLockOpts {
  ttlMs?: number;
  /**
   * closed — money jobs: without a real lock the job refuses to run and the
   *   workflow's notify-on-failure step pages (silent unlocked double-runs of
   *   dunning/payout sweeps are worse than a missed schedule).
   * open — cleanup/alert jobs: run unlocked with a warning when the lock table
   *   is unavailable; their side effects are harmless to repeat.
   */
  failMode: "open" | "closed";
}

/** #697 — errorLog is @db.Text but a stack dump has no business being unbounded. */
const ERROR_LOG_MAX_CHARS = 8_000;

const LEASE_EXPIRED_SWEEP_MESSAGE = "Lease expired (stale RUNNING row swept)";

type SystemJobExecutionDelegate = Awaited<
  ReturnType<typeof getExecutionDelegate>
>;

const PRISMA_CONNECTION_ERROR_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);

function isDbConnectionOrPoolError(error: unknown): boolean {
  if (isPoolExhaustion(error)) return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && PRISMA_CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }
  const msg = (error as { message?: unknown }).message;
  return (
    typeof msg === "string" &&
    /connection|pool|timeout|unreachable|ECONNREFUSED|ECONNRESET|terminating connection/i.test(
      msg,
    )
  );
}

async function getExecutionDelegate() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.systemJobExecution;
}

async function touchRedisHeartbeat(): Promise<void> {
  try {
    const { default: redis } = await import("@/lib/redis");
    await redis.set("cron:heartbeat:last", new Date().toISOString());
  } catch {
    // Execution history remains authoritative when Redis is unavailable.
  }
}

async function recordJobFinish(
  jobName: string,
  delegate: SystemJobExecutionDelegate,
  executionId: string | null,
  acquiredAtMs: number,
  outcome: JobOutcome,
  error?: unknown,
): Promise<void> {
  if (!executionId) return;
  try {
    const now = new Date();
    const finished = await delegate.updateMany({
      where: { id: executionId, status: "RUNNING" },
      data: {
        status:
          outcome === "success"
            ? "COMPLETED"
            : outcome === "held"
              ? "CANCELLED"
              : "FAILED",
        result: {
          outcome,
          environment:
            process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
            process.env.SENTRY_ENVIRONMENT ??
            "unknown",
        },
        endedAt: now,
        durationMs: Math.max(0, now.getTime() - acquiredAtMs),
        errorLog:
          error === undefined
            ? undefined
            : String(
                error instanceof Error ? (error.stack ?? error.message) : error,
              ).slice(0, ERROR_LOG_MAX_CHARS),
      },
    });
    if (finished.count > 0 && outcome === "success")
      await touchRedisHeartbeat();
  } catch (err) {
    console.warn(`[${jobName}] job-trail finish write failed:`, err);
  }
}

export async function withCronLock<T>(
  jobName: string,
  opts: CronLockOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  let delegate: SystemJobExecutionDelegate;

  let executionId: string | null = null;
  try {
    delegate = await getExecutionDelegate();
    const now = new Date();
    const cutoff = new Date(now.getTime() - ttlMs);

    // Sweep stale RUNNING rows whose lease has expired before checking or
    // inserting, so `SystemJobExecution_running_jobName_key` is released for
    // crashed runs while preserving an explicit audit trail.
    await delegate.updateMany({
      where: {
        jobName,
        status: "RUNNING",
        startedAt: { lte: cutoff },
      },
      data: {
        status: "FAILED",
        endedAt: now,
        errorLog: LEASE_EXPIRED_SWEEP_MESSAGE,
      },
    });

    const active = await delegate.findFirst({
      where: {
        jobName,
        status: "RUNNING",
        startedAt: { gt: cutoff },
      },
      select: { id: true },
    });
    if (active) throw new CronLockHeldError(jobName);

    const row = await delegate.create({
      data: {
        jobId: jobName,
        jobName,
        status: "RUNNING",
        triggeredBy: process.env.GITHUB_ACTIONS ? "github-actions" : "cron",
      },
      select: { id: true },
    });
    if (row === null) {
      throw new CronLockHeldError(jobName);
    }
    executionId = row.id;
  } catch (err) {
    if (err instanceof CronLockHeldError) {
      throw err;
    }
    if (isUniqueViolation(err)) {
      throw new CronLockHeldError(jobName);
    }
    if (opts.failMode === "closed" || isDbConnectionOrPoolError(err)) {
      throw new CronLockUnavailableError(jobName);
    }
    console.warn(
      `[${jobName}] Postgres cron lock unavailable — running UNLOCKED (fail-open):`,
      err,
    );
    return fn();
  }

  // Capture original acquisition timestamp in closure memory so lease renewals
  // advancing `startedAt` never skew the final `durationMs` calculation.
  const acquiredAtMs = Date.now();
  const renewal = startLeaseRenewal(jobName, delegate, executionId, ttlMs);

  try {
    const result = await fn();
    const outcome = jobOutcome(result);
    await recordJobFinish(
      jobName,
      delegate,
      executionId,
      acquiredAtMs,
      outcome,
      outcome === "failure" || outcome === "partial_failure"
        ? new Error(`Job returned ${outcome}`)
        : undefined,
    );
    return result;
  } catch (err) {
    await recordJobFinish(
      jobName,
      delegate,
      executionId,
      acquiredAtMs,
      "failure",
      err,
    );
    throw err;
  } finally {
    renewal.stop();
  }
}

function startLeaseRenewal(
  jobName: string,
  delegate: SystemJobExecutionDelegate,
  executionId: string | null,
  ttlMs: number,
): { stop: () => void } {
  if (!executionId) {
    return { stop: () => {} };
  }
  let lost = false;
  const timer = setInterval(
    async () => {
      if (lost) return;
      try {
        const res = await delegate.updateMany({
          where: { id: executionId, status: "RUNNING" },
          data: { startedAt: new Date() },
        });
        if (res.count === 0) {
          lost = true;
          console.warn(
            `[${jobName}] cron lock renewal failed — ownership lost`,
          );
          try {
            Sentry.logger.warn("cron lock renewal failed — ownership lost", {
              jobName,
              executionId,
            });
            Sentry.metrics.count("cron.lock_ownership_lost", 1, {
              attributes: { job_name: jobName },
            });
          } catch {
            // Telemetry must never break cron execution.
          }
        }
      } catch (err) {
        console.warn(`[${jobName}] cron lock renewal error:`, err);
      }
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
