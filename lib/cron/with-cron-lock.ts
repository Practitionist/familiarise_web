import { acquireLock, releaseLock, isMockRedis, checkRedisHealth } from "@/lib/redis";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/cron-lock-errors";

/**
 * #476 — distributed mutual exclusion for cron job entries. Schedule overlap,
 * workflow_dispatch re-runs, and the GH-Actions + CRON_SECRET HTTP double
 * entry can all run the same job twice; jobs whose side effects are only
 * partially idempotent (dunning emails, notify fan-outs) must not double-run.
 *
 * This wraps the CORE function (scripts/** or lib/**) so every entry point
 * inherits the lock. It is for mutual exclusion only — data correctness comes
 * from the CAS transitions and unique constraints, never from this lock
 * (Redis is a different failure domain than Postgres; see ADR 13).
 */

// The error types live in a leaf module so an `instanceof` check does not drag
// lib/redis (which throws at import without Upstash env) in with it. Re-exported
// here because ~44 call sites already import them from this path. (#1066)
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
   * open — cleanup/alert jobs: run unlocked with a warning when Redis is
   *   absent; their side effects are harmless to repeat.
   */
  failMode: "open" | "closed";
}

export async function withCronLock<T>(
  jobName: string,
  opts: CronLockOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `cron:lock:${jobName}`;

  if (isMockRedis()) {
    if (opts.failMode === "closed") throw new CronLockUnavailableError(jobName);
    console.warn(
      `[${jobName}] Redis not configured — running UNLOCKED (fail-open)`,
    );
    return fn();
  }

  // acquireLock returns null for BOTH "held" and "circuit open". Held is a
  // clean skip; an unreachable Redis on a fail-closed job must page instead —
  // otherwise money jobs freeze silently for as long as the outage lasts.
  if (opts.failMode === "closed") {
    const healthy = await checkRedisHealth();
    if (!healthy) throw new CronLockUnavailableError(jobName);
  }

  const token = await acquireLock(key, opts.ttlMs ?? DEFAULT_TTL_MS);
  if (!token) throw new CronLockHeldError(jobName);

  try {
    return await fn();
  } finally {
    await releaseLock(key, token); // never throws; TTL is the safety net
  }
}
