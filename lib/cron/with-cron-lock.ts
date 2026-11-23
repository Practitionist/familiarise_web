import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/core";
import { z } from "zod";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/cron-lock-errors";
import { isPoolExhaustion, isUniqueViolation } from "@/lib/db/pg-errors";
import { jobOutcome } from "@/lib/cron/job-outcome";
import {
  currentRun,
  noteCounter,
  noteRunFinished,
  noteRunId,
  schedulerTrigger,
} from "@/lib/cron/run-context";
import {
  checkpointOf,
  jobEnvironment,
  runOutcomeOfJob,
  statusOfOutcome,
  type RunOutcome,
} from "@/lib/cron/run-outcome";
import { onNetlify } from "@/lib/runtime-host";
import { mayWriteProductionState } from "@/lib/production-state";

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

const runEnvironmentSchema = z.object({ environment: z.string() });

/** `/api/health` reads it as production's dead-man signal. */
const HEARTBEAT_KEY = "cron:heartbeat:last";

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

export function isDbConnectionOrPoolError(error: unknown): boolean {
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

/** The same fault, raised by Prisma itself, so a vendor timeout in a mixed path is not mistaken for one. */
export function isPrismaConnectionOrPoolError(error: unknown): boolean {
  if (!isDbConnectionOrPoolError(error) || typeof error !== "object") {
    return false;
  }
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (typeof code === "string" && PRISMA_CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }
  return (
    typeof name === "string" &&
    (name.startsWith("PrismaClient") || name === "DriverAdapterError")
  );
}

async function getExecutionDelegate() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.systemJobExecution;
}

async function touchRedisHeartbeat(): Promise<void> {
  if (!mayWriteProductionState(HEARTBEAT_KEY)) return;
  try {
    const { default: redis } = await import("@/lib/redis");
    await redis.set(HEARTBEAT_KEY, new Date().toISOString());
  } catch {
    // Execution history remains authoritative when Redis is unavailable.
  }
}

/**
 * The checkpoint the job's latest finished run that recorded one left, or null to start from the beginning.
 * Runs that wrote no checkpoint key are skipped however many there are; a JSON null is the wrap marker.
 */
export async function readJobCheckpoint(
  jobName: string,
): Promise<string | null> {
  const { default: prisma } = await import("@/lib/prisma");
  // Prisma's JSON filters cannot test for a key, and a missing key differs from a JSON null only in SQL.
  const rows = await prisma.$queryRaw<{ result: unknown }[]>`
    SELECT "result" FROM "SystemJobExecution"
    WHERE "jobName" = ${jobName}
      AND "status" IN ('COMPLETED', 'FAILED')
      AND jsonb_exists("result", 'checkpoint')
    ORDER BY "startedAt" DESC
    LIMIT 1`;
  return checkpointOf(rows[0]?.result)?.checkpoint ?? null;
}

async function recordJobFinish(
  jobName: string,
  delegate: SystemJobExecutionDelegate,
  executionId: string | null,
  acquiredAtMs: number,
  outcome: RunOutcome,
  error?: unknown,
  checkpoint?: { checkpoint: string | null } | null,
): Promise<void> {
  if (!executionId) return;
  try {
    const now = new Date();
    const finished = await delegate.updateMany({
      where: { id: executionId, status: "RUNNING" },
      data: {
        status: statusOfOutcome(outcome),
        result: {
          outcome,
          environment: jobEnvironment(),
          ...(checkpoint ?? {}),
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
    if (finished.count > 0) noteRunFinished(executionId, checkpoint ?? null);
    if (finished.count > 0 && outcome === "completed")
      await touchRedisHeartbeat();
  } catch (err) {
    console.warn(`[${jobName}] job-trail finish write failed:`, err);
  }
}

/** Tags every Sentry event of this request with the run id; telemetry never breaks a run. */
function tagSentryRun(executionId: string): void {
  try {
    Sentry.getIsolationScope().setTag("job_run_id", executionId);
  } catch {
    // Sentry may be uninitialised in CLI runs.
  }
}

// Renewal refreshes a live run every ttl/3 (background functions included), so a
// short lease only shortens how long a killed Netlify run's row blocks the next tick.
const NETLIFY_MAX_LEASE_MS = 90_000;

export function effectiveLeaseTtlMs(ttlMs: number): number {
  return onNetlify() ? Math.min(ttlMs, NETLIFY_MAX_LEASE_MS) : ttlMs;
}

export async function withCronLock<T>(
  jobName: string,
  opts: CronLockOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const ttlMs = effectiveLeaseTtlMs(opts.ttlMs ?? DEFAULT_TTL_MS);
  let delegate: SystemJobExecutionDelegate;

  let executionId: string | null = null;
  try {
    delegate = await getExecutionDelegate();
    const now = new Date();
    const cutoff = new Date(now.getTime() - ttlMs);
    const newId = randomUUID();

    // `startedAt` is the last heartbeat and `createdAt` the acquisition.
    // The partial unique index allows at most one RUNNING row per job.
    const running = await delegate.findFirst({
      where: { jobName, status: "RUNNING" },
      select: { id: true, startedAt: true, createdAt: true, result: true },
    });
    if (running && running.startedAt > cutoff) {
      throw new CronLockHeldError(jobName, running.id);
    }
    if (running) {
      // The swept row keeps its owner's environment, not the taker's.
      const owner = runEnvironmentSchema.safeParse(running.result);
      const swept = await delegate.updateMany({
        where: {
          id: running.id,
          status: "RUNNING",
          startedAt: { lte: cutoff },
        },
        data: {
          status: "FAILED",
          endedAt: now,
          durationMs: Math.max(0, now.getTime() - running.createdAt.getTime()),
          errorLog: LEASE_EXPIRED_SWEEP_MESSAGE,
          result: {
            outcome: "failed",
            reason: "lease-expired",
            ...(owner.success ? owner.data : {}),
            takenOverBy: newId,
          },
        },
      });
      if (swept.count > 0) noteCounter("leaseTakeover");
    }

    const row = await delegate.create({
      data: {
        id: newId,
        jobId: jobName,
        jobName,
        status: "RUNNING",
        triggeredBy: currentRun()?.triggeredBy ?? schedulerTrigger(),
        result: { environment: jobEnvironment() },
      },
      select: { id: true },
    });
    if (row === null) {
      throw new CronLockHeldError(jobName);
    }
    executionId = row.id;
    noteRunId(row.id);
    tagSentryRun(row.id);
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

  // Renewals advance `startedAt`, so duration is measured from this acquisition instant.
  const acquiredAtMs = Date.now();
  const renewal = startLeaseRenewal(jobName, delegate, executionId, ttlMs);

  try {
    const result = await fn();
    const outcome = runOutcomeOfJob(jobOutcome(result));
    await recordJobFinish(
      jobName,
      delegate,
      executionId,
      acquiredAtMs,
      outcome,
      outcome === "failed" || outcome === "partial"
        ? new Error(`Job returned ${outcome}`)
        : undefined,
      checkpointOf(result),
    );
    return result;
  } catch (err) {
    await recordJobFinish(
      jobName,
      delegate,
      executionId,
      acquiredAtMs,
      "failed",
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
          noteCounter("leaseLost");
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
