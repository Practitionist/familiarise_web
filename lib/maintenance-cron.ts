/**
 * Maintenance Mode Guard — Cron & Background Job Utility
 */

import redis from "@/lib/redis";
import { z } from "zod";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";

export { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";

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

export class MaintenanceUnavailableError extends Error {
  readonly httpStatus = 503;
  constructor() {
    super("Maintenance state is unreadable; mutations are paused");
    this.name = "MaintenanceUnavailableError";
  }
}

const PHASE_CACHE_MS = 60_000;
const PHASE_FAILURE_CACHE_MS = 5_000;
let phaseCacheTtlMs = PHASE_CACHE_MS;
let phaseCachedAt = 0;
let phaseCachedValue: string | null = null;
let phaseCacheHasValue = false;

/**
 * Read `maintenance:phase` from Redis with a 60s success cache, falling back to
 * the Postgres window for 5s when Redis fails. `bypassCache` forces a fresh read.
 */
export async function readMaintenancePhase(
  jobName = "maintenance",
  options?: { bypassCache?: boolean },
): Promise<string | null> {
  const now = Date.now();
  if (
    !options?.bypassCache &&
    phaseCacheHasValue &&
    now - phaseCachedAt < phaseCacheTtlMs
  ) {
    return phaseCachedValue;
  }

  try {
    const raw = await redis.get<string>(REDIS_KEYS.PHASE);
    const phase = z.enum(["OFF", "DEGRADED", "OFFLINE"]).parse(raw);
    phaseCachedValue = phase;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    phaseCacheTtlMs = PHASE_CACHE_MS;
    return phase;
  } catch (error) {
    const fallback = await readPhaseFromPostgres();
    console.warn(
      `[${jobName}] Could not read maintenance state from Redis (${
        error instanceof Error ? error.message : String(error)
      }) — ${fallback === null ? "refusing mutation" : `using Postgres phase ${fallback}`}`,
    );
    phaseCachedValue = fallback;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    phaseCacheTtlMs = PHASE_FAILURE_CACHE_MS;
    captureThrottled(
      "maintenance-cron:readMaintenancePhase",
      error instanceof Error ? error : new Error(String(error)),
      { subsystem: "maintenance", expected: false },
    );
    return fallback;
  }
}

// The MaintenanceWindow row is the truth Redis mirrors, so a Redis outage reads
// it directly; null (refuse) only when Postgres cannot answer either.
async function readPhaseFromPostgres(): Promise<string | null> {
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const row = await prisma.maintenanceWindow.findFirst({
      where: { organizationId: null, phase: { not: "OFF" } },
      orderBy: { createdAt: "desc" },
      select: { phase: true },
    });
    return row?.phase ?? "OFF";
  } catch {
    return null;
  }
}

export function invalidateMaintenancePhaseCache(): void {
  phaseCachedAt = 0;
  phaseCachedValue = null;
  phaseCacheHasValue = false;
  phaseCacheTtlMs = PHASE_CACHE_MS;
}

export const resetMaintenancePhaseCacheForTesting =
  invalidateMaintenancePhaseCache;

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

export async function assertNotInMaintenance(jobName: string): Promise<void> {
  const phase = await readMaintenancePhase(jobName);
  if (phase === null) throw new MaintenanceUnavailableError();
  const blocking = blockingPhaseFor(phase, jobName);
  if (blocking) throw new MaintenanceActiveError(jobName, blocking);
}
