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

/** Redis keys are refreshed on every active read, so a window may outlive this TTL. */
const MAINTENANCE_KEY_TTL_SECONDS = 24 * 60 * 60;

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

      await Promise.all([
        redis.pexpire(REDIS_KEYS.PHASE, MAINTENANCE_KEY_TTL_SECONDS * 1000),
        redis.pexpire(REDIS_KEYS.CONFIG, MAINTENANCE_KEY_TTL_SECONDS * 1000),
      ]);

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
  await Promise.all([
    redis.set(REDIS_KEYS.PHASE, phase, { ex: MAINTENANCE_KEY_TTL_SECONDS }),
    redis.set(
      REDIS_KEYS.CONFIG,
      JSON.stringify({
        reason: config.reason ?? null,
        estimatedEnd: config.estimatedEnd ?? null,
        bypassSecret: config.bypassSecret ?? null,
        betterstackIncidentId: config.betterstackIncidentId ?? null,
      }),
      { ex: MAINTENANCE_KEY_TTL_SECONDS },
    ),
  ]);
  invalidateMaintenancePhaseCache();

  const estimatedEndDate =
    config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
      ? new Date(config.estimatedEnd)
      : undefined;

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
