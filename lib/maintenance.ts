/**
 * Maintenance Mode Library
 *
 * Two-tier state management:
 * - Redis: fast edge reads for middleware (fail-open: defaults to OFF if unreachable)
 * - Prisma: audit trail and scheduling for admin dashboard
 *
 * Three phases: OFF → DEGRADED (read-only, warning banner) → OFFLINE (full maintenance page)
 */

import { MaintenancePhase } from "@prisma/client";

import prisma from "@/lib/prisma";
import redis, { withCircuitBreaker } from "@/lib/redis";

// Redis key constants
const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
} as const;

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

/**
 * Read current maintenance state from Redis.
 * Fail-open: returns OFF if Redis is unreachable.
 */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  return withCircuitBreaker(
    async () => {
      const [phase, configRaw] = await Promise.all([
        redis.get<string>(REDIS_KEYS.PHASE),
        redis.get<string>(REDIS_KEYS.CONFIG),
      ]);

      if (!phase || phase === "OFF") return OFF_STATE;

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
    // Fail-open: site stays up if Redis is down
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
  // Write both Redis keys concurrently to minimize inconsistency window
  await Promise.all([
    redis.set(REDIS_KEYS.PHASE, phase),
    redis.set(
      REDIS_KEYS.CONFIG,
      JSON.stringify({
        reason: config.reason ?? null,
        estimatedEnd: config.estimatedEnd ?? null,
        bypassSecret: config.bypassSecret ?? null,
        betterstackIncidentId: config.betterstackIncidentId ?? null,
      }),
    ),
  ]);

  // Persist to Prisma for audit trail (transactional to prevent find+update races)
  await prisma.$transaction(async (tx) => {
    if (phase === MaintenancePhase.OFF) {
      const activeWindow = await tx.maintenanceWindow.findFirst({
        where: { phase: { not: MaintenancePhase.OFF } },
        orderBy: { createdAt: "desc" },
      });

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
    } else {
      const activeWindow = await tx.maintenanceWindow.findFirst({
        where: { phase: { not: MaintenancePhase.OFF } },
        orderBy: { createdAt: "desc" },
      });

      if (activeWindow) {
        await tx.maintenanceWindow.update({
          where: { id: activeWindow.id },
          data: {
            phase,
            reason: config.reason,
            estimatedEnd:
              config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
                ? new Date(config.estimatedEnd)
                : undefined,
          },
        });
      } else {
        await tx.maintenanceWindow.create({
          data: {
            phase,
            reason: config.reason,
            startedAt: new Date(),
            startedBy: config.startedBy,
            estimatedEnd:
              config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
                ? new Date(config.estimatedEnd)
                : undefined,
            bypassSecret: config.bypassSecret,
          },
        });
      }
    }
  });
}

