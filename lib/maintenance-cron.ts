/**
 * Maintenance Mode Guard — Cron & Background Job Utility
 */

import redis from "@/lib/redis";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import { flushJobSentry } from "@/lib/observability/job-sentry";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";

export { FINANCIAL_JOB_NAMES, isFinancialJob } from "@/lib/cron/financial-jobs";

export type BlockingMaintenancePhase = "OFFLINE" | "DEGRADED";

export class MaintenanceActiveError extends Error {
  readonly httpStatus = 503;
  readonly phase: BlockingMaintenancePhase;
  readonly jobName: string;

  constructor(jobName: string, phase: BlockingMaintenancePhase) {
    super(
      phase === "OFFLINE"
        ? `Maintenance mode is OFFLINE — ${jobName} is unavailable while the database may be mid-migration`
        : `Maintenance mode is DEGRADED — ${jobName} is a financial job and is unavailable until maintenance ends`,
    );
    this.name = "MaintenanceActiveError";
    this.jobName = jobName;
    this.phase = phase;
  }
}

const PHASE_CACHE_MS = 60_000;
const PHASE_FAILURE_CACHE_MS = 5_000;
let phaseCacheTtlMs = PHASE_CACHE_MS;
let phaseCachedAt = 0;
let phaseCachedValue: string | null = null;
let phaseCacheHasValue = false;

/**
 * Read `maintenance:phase` from Redis with a 60s success cache (5s failure cache).
 */
export async function readMaintenancePhase(
  jobName = "maintenance",
): Promise<string | null> {
  const now = Date.now();
  if (phaseCacheHasValue && now - phaseCachedAt < phaseCacheTtlMs) {
    return phaseCachedValue;
  }

  try {
    const phase = await redis.get<string>(REDIS_KEYS.PHASE);
    phaseCachedValue = phase;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    phaseCacheTtlMs = PHASE_CACHE_MS;
    return phase;
  } catch (error) {
    console.warn(
      `[${jobName}] Could not check maintenance state (Redis error: ${
        error instanceof Error ? error.message : String(error)
      }) — proceeding`,
    );
    phaseCachedValue = null;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    phaseCacheTtlMs = PHASE_FAILURE_CACHE_MS;
    captureThrottled(
      "maintenance-cron:readMaintenancePhase",
      error instanceof Error ? error : new Error(String(error)),
      { subsystem: "maintenance", expected: false },
    );
    return null;
  }
}

export function resetMaintenancePhaseCacheForTesting(): void {
  phaseCachedAt = 0;
  phaseCachedValue = null;
  phaseCacheHasValue = false;
  phaseCacheTtlMs = PHASE_CACHE_MS;
}

function blockingPhaseFor(
  phase: string | null,
  jobName: string,
): BlockingMaintenancePhase | null {
  if (phase === "OFFLINE") return "OFFLINE";
  if (phase === "DEGRADED" && FINANCIAL_JOB_NAMES.has(jobName)) {
    return "DEGRADED";
  }
  return null;
}

export async function abortIfMaintenance(jobName: string): Promise<void> {
  const phase = await readMaintenancePhase(jobName);
  const blocking = blockingPhaseFor(phase, jobName);

  if (blocking === "OFFLINE") {
    console.log(
      `[${jobName}] Maintenance mode is OFFLINE — skipping job to protect DB during migration`,
    );
  } else if (blocking === "DEGRADED") {
    console.log(
      `[${jobName}] Maintenance mode is DEGRADED — skipping financial job to protect payment integrity`,
    );
  } else {
    if (phase === "DEGRADED") {
      console.log(
        `[${jobName}] Maintenance mode is DEGRADED — proceeding (non-financial job)`,
      );
    }
    return;
  }

  await flushJobSentry();
  process.exit(0);
}

export async function assertNotInMaintenance(jobName: string): Promise<void> {
  const phase = await readMaintenancePhase(jobName);
  const blocking = blockingPhaseFor(phase, jobName);
  if (blocking) throw new MaintenanceActiveError(jobName, blocking);
}
