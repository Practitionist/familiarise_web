/**
 * Maintenance Mode Library (Node.js reader & writer)
 */

import { MaintenancePhase } from "@prisma/client";

import prisma from "@/lib/prisma";
import redis, { withCircuitBreaker } from "@/lib/redis";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import {
  invalidateMaintenancePhaseCache,
  readMaintenancePhase,
  resetMaintenancePhaseCacheForTesting,
} from "@/lib/maintenance-cron";

export {
  invalidateMaintenancePhaseCache,
  readMaintenancePhase,
  resetMaintenancePhaseCacheForTesting,
};

export interface MaintenanceState {
  phase: MaintenancePhase;
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
  betterstackIncidentId: string | null;
}

const OFF_STATE: MaintenanceState = {
  phase: MaintenancePhase.OFF,
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
  betterstackIncidentId: null,
};

/** Upper bound on the Redis key TTL; a window with no planned end expires after this. */
const MAINTENANCE_KEY_TTL_SECONDS = 24 * 60 * 60;
/** How long past its planned end an untended window stays up before the keys expire. */
const MAINTENANCE_GRACE_MS = 60 * 60 * 1000;

/** TTL capped at the planned end plus grace; null once that deadline has passed. */
function maintenanceKeyTtlSeconds(
  estimatedEnd: Date | null | undefined,
  now: number,
): number | null {
  if (!estimatedEnd) return MAINTENANCE_KEY_TTL_SECONDS;
  const remainingMs = estimatedEnd.getTime() + MAINTENANCE_GRACE_MS - now;
  if (remainingMs <= 0) return null;
  return Math.min(MAINTENANCE_KEY_TTL_SECONDS, Math.ceil(remainingMs / 1000));
}

/**
 * The DB row is the source of truth: Redis keys are re-armed only while the
 * platform window is open and its planned end plus grace is still ahead.
 */
async function refreshMaintenanceKeysFromWindow(): Promise<void> {
  const row = await prisma.maintenanceWindow.findFirst({
    where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
    orderBy: { createdAt: "desc" },
    select: { estimatedEnd: true },
  });
  if (!row?.estimatedEnd) return;
  const ttlSeconds = maintenanceKeyTtlSeconds(row.estimatedEnd, Date.now());
  if (ttlSeconds === null) return;
  await Promise.all([
    redis.pexpire(REDIS_KEYS.PHASE, ttlSeconds * 1000),
    redis.pexpire(REDIS_KEYS.CONFIG, ttlSeconds * 1000),
  ]);
}

/**
 * Read current maintenance state directly from Redis (uncached on entry so
 * cross-instance admin/money-gate reads never observe a stale 60s cached OFF).
 * Fail-open: returns OFF if Redis is unreachable.
 */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  return withCircuitBreaker(
    async () => {
      const phase = await readMaintenancePhase("maintenance", {
        bypassCache: true,
      });
      if (!phase || phase === "OFF") return OFF_STATE;

      // A failed refresh must not turn an active window into OFF_STATE.
      await refreshMaintenanceKeysFromWindow().catch((error: unknown) => {
        console.warn(
          "[maintenance] TTL refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
      });

      const configRaw = await redis.get<string>(REDIS_KEYS.CONFIG);
      let config: Partial<MaintenanceState> = {};
      if (configRaw) {
        try {
          config =
            typeof configRaw === "string" ? JSON.parse(configRaw) : configRaw;
        } catch {
          // Malformed config — treat as no config
        }
      }

      return {
        phase: phase as MaintenancePhase,
        reason: config.reason ?? null,
        estimatedEnd: config.estimatedEnd ?? null,
        bypassSecret: config.bypassSecret ?? null,
        betterstackIncidentId: config.betterstackIncidentId ?? null,
      };
    },
    () => OFF_STATE,
  );
}

/**
 * Set maintenance state in Redis and persist to Prisma.
 */
export async function setMaintenanceState(
  phase: MaintenancePhase,
  config: {
    reason?: string;
    estimatedEnd?: string;
    bypassSecret?: string;
    startedBy?: string;
    endedBy?: string;
    betterstackIncidentId?: string;
  } = {},
): Promise<void> {
  const estimatedEndDate =
    config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
      ? new Date(config.estimatedEnd)
      : undefined;
  // A planned end already past its grace still gets one grace period to be tended.
  const ttlSeconds =
    phase === MaintenancePhase.OFF
      ? MAINTENANCE_KEY_TTL_SECONDS
      : (maintenanceKeyTtlSeconds(estimatedEndDate, Date.now()) ??
        MAINTENANCE_GRACE_MS / 1000);

  await Promise.all([
    redis.set(REDIS_KEYS.PHASE, phase, { ex: ttlSeconds }),
    redis.set(
      REDIS_KEYS.CONFIG,
      JSON.stringify({
        reason: config.reason ?? null,
        estimatedEnd: config.estimatedEnd ?? null,
        bypassSecret: config.bypassSecret ?? null,
        betterstackIncidentId: config.betterstackIncidentId ?? null,
      }),
      { ex: ttlSeconds },
    ),
  ]);
  invalidateMaintenancePhaseCache();

  await prisma.$transaction(async (tx) => {
    const activeWindow = await tx.maintenanceWindow.findFirst({
      where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
      orderBy: { createdAt: "desc" },
    });

    if (phase === MaintenancePhase.OFF) {
      if (activeWindow) {
        await tx.maintenanceWindow.update({
          where: { id: activeWindow.id },
          data: {
            phase: MaintenancePhase.OFF,
            endedAt: new Date(),
            endedBy: config.endedBy,
          },
        });
      }
    } else if (activeWindow) {
      await tx.maintenanceWindow.update({
        where: { id: activeWindow.id },
        data: {
          phase,
          reason: config.reason,
          estimatedEnd: estimatedEndDate,
        },
      });
    } else {
      await tx.maintenanceWindow.create({
        data: {
          phase,
          reason: config.reason,
          startedAt: new Date(),
          startedBy: config.startedBy,
          estimatedEnd: estimatedEndDate,
          bypassSecret: config.bypassSecret,
        },
      });
    }
  });
}

/**
 * Read the currently-active MaintenanceWindow row scoped to a single organization.
 */
export async function getActiveOrgMaintenanceWindow(
  organizationId: string,
): Promise<{
  phase: MaintenancePhase;
  reason: string | null;
  estimatedEnd: Date | null;
} | null> {
  const row = await prisma.maintenanceWindow.findFirst({
    where: {
      organizationId,
      phase: { not: MaintenancePhase.OFF },
    },
    orderBy: { createdAt: "desc" },
    select: { phase: true, reason: true, estimatedEnd: true },
  });
  return row ?? null;
}
