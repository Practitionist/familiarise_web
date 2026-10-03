import * as Sentry from "@sentry/nextjs";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/cron-lock-errors";
import { isPoolExhaustion, isUniqueViolation } from "@/lib/db/pg-errors";

/**
 * #476 / #1915 — distributed mutual exclusion for cron job entries backed by a
 * Postgres lease on `SystemJobExecution`.
 *
 * Schedule overlap, workflow_dispatch re-runs, and the GH-Actions + CRON_SECRET
 * HTTP double entry can all run the same job twice; jobs whose side effects are
 * only partially idempotent (dunning emails, notify fan-outs) must not
 * double-run.
 *
 * A job holds the lease while a `SystemJobExecution` row with
 * `jobName, status = "RUNNING", startedAt > now - ttlMs` exists, enforced at
 * the database level by `SystemJobExecution_running_jobName_key`
 * (`prisma/sql/partial-indexes.sql`).
 */

export { CronLockHeldError, CronLockUnavailableError };

const DEFAULT_TTL_MS = 15 * 60 * 1000; // workflows set timeout-minutes: 10
/** Payout/reconcile family runs up to 30 min (ADR 05) — lock must outlive it. */
export const LONG_JOB_TTL_MS = 35 * 60 * 1000;

/** Test-only: retained for call-site compatibility. */
export function resetCronHealthCacheForTesting(): void {}

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

type SystemJobExecutionDelegate = {
  findFirst?: (args: {
    where: {
      jobName: string;
      status: "RUNNING";
      startedAt: { gt: Date };
    };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
  create?: (args: {
    data: {
      jobId: string;
      jobName: string;
      status: "RUNNING";
      triggeredBy: string;
    };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
  update?: (args: {
    where: { id: string };
    data: {
      status?: "RUNNING" | "COMPLETED" | "FAILED";
      startedAt?: Date;
      endedAt?: Date;
      durationMs?: number;
      errorLog?: string;
    };
  }) => Promise<unknown>;
  updateMany?: (args: {
    where: {
      id?: string;
      jobName?: string;
      status: "RUNNING";
      startedAt?: { lte: Date };
    };
    data: {
      startedAt?: Date;
      status?: "FAILED";
      endedAt?: Date;
      errorLog?: string;
    };
  }) => Promise<{ count: number }>;
};

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

async function getExecutionDelegate(): Promise<SystemJobExecutionDelegate | null> {
  try {
    const mod = await import("@/lib/prisma");
    const prisma = mod.default as unknown as
      | { systemJobExecution?: SystemJobExecutionDelegate }
      | undefined;
    return prisma?.systemJobExecution ?? null;
  } catch {
    return null;
  }
}

async function touchRedisHeartbeat(): Promise<void> {
  try {
    const mod = await import("@/lib/redis");
    const redis = mod.default as
      | { set?: (key: string, value: string) => Promise<unknown> }
      | undefined;
    if (redis && typeof redis.set === "function") {
      await Promise.resolve(
        redis.set("cron:heartbeat:last", new Date().toISOString()),
      ).catch(() => {});
    }
  } catch {
    // Non-fatal: Postgres SystemJobExecution is the authoritative trail.
  }
}

async function recordJobFinish(
  jobName: string,
  delegate: SystemJobExecutionDelegate | null,
  executionId: string | null,
  acquiredAtMs: number,
  error?: unknown,
): Promise<void> {
  if (error === undefined) {
    await touchRedisHeartbeat();
  }
  if (!executionId || typeof delegate?.update !== "function") return;
  try {
    const now = new Date();
    await delegate.update({
      where: { id: executionId },
      data: {
        status: error === undefined ? "COMPLETED" : "FAILED",
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
  const delegate = await getExecutionDelegate();

  // Graceful fallback when `prisma.systemJobExecution` is omitted in partial unit-test mocks.
  if (!delegate || typeof delegate.create !== "function") {
    return fn();
  }

  let executionId: string | null = null;
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - ttlMs);

    // Sweep stale RUNNING rows whose lease has expired before checking or
    // inserting, so `SystemJobExecution_running_jobName_key` is released for
    // crashed runs while preserving an explicit audit trail.
    if (typeof delegate.updateMany === "function") {
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
    }

    if (typeof delegate.findFirst === "function") {
      const active = await delegate.findFirst({
        where: {
          jobName,
          status: "RUNNING",
          startedAt: { gt: cutoff },
        },
        select: { id: true },
      });
      if (active) {
        throw new CronLockHeldError(jobName);
      }
    }

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
    executionId = row?.id ?? null;
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
    await recordJobFinish(jobName, delegate, executionId, acquiredAtMs);
    return result;
  } catch (err) {
    await recordJobFinish(jobName, delegate, executionId, acquiredAtMs, err);
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
  if (!executionId || typeof delegate.updateMany !== "function") {
    return { stop: () => {} };
  }
  let lost = false;
  const timer = setInterval(
    async () => {
      if (lost) return;
      try {
        const res = await delegate.updateMany!({
          where: { id: executionId, status: "RUNNING" },
          data: { startedAt: new Date() },
        });
        if (res.count === 0) {
          lost = true;
          console.warn(
            `[${jobName}] cron lock renewal failed — ownership lost`,
          );
          try {
            Sentry.logger?.warn("cron lock renewal failed — ownership lost", {
              jobName,
              executionId,
            });
            Sentry.metrics?.count("cron.lock_ownership_lost", 1, {
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
