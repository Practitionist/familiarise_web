/**
 * Maintenance Mode Library (Node.js reader & writer)
 */

import { MaintenancePhase } from "@prisma/client";
import {
  notifyMaintenanceEnded,
  notifyMaintenanceScheduled,
} from "@/lib/novu/service";

import prisma from "@/lib/prisma";
import redis from "@/lib/redis";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
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
  offlineActivatedAt: string | null;
}

const OFF_STATE: MaintenanceState = {
  phase: MaintenancePhase.OFF,
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
  betterstackIncidentId: null,
  offlineActivatedAt: null,
};

/** The database owns the window; ETA is informational and never reopens traffic. */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  const row = await prisma.maintenanceWindow.findFirst({
    where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return OFF_STATE;
  return {
    phase: row.phase,
    reason: row.reason,
    estimatedEnd: row.estimatedEnd?.toISOString() ?? null,
    bypassSecret: row.bypassSecret,
    betterstackIncidentId: row.betterstackIncidentId,
    offlineActivatedAt: row.offlineActivatedAt?.toISOString() ?? null,
  };
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
    betterstackIncidentId?: string | null;
    auditReason?: string;
  } = {},
): Promise<void> {
  const estimatedEndDate =
    config.estimatedEnd && !isNaN(new Date(config.estimatedEnd).getTime())
      ? new Date(config.estimatedEnd)
      : undefined;
  const window = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform-maintenance'))`;
    const activeWindow = await tx.maintenanceWindow.findFirst({
      where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
      orderBy: { createdAt: "desc" },
    });

    let row = activeWindow;
    if (phase === MaintenancePhase.OFF) {
      await tx.maintenanceWindow.updateMany({
        where: { organizationId: null, phase: { not: MaintenancePhase.OFF } },
        data: {
          phase: MaintenancePhase.OFF,
          endedAt: new Date(),
          endedBy: config.endedBy,
        },
      });
    } else if (activeWindow) {
      row = await tx.maintenanceWindow.update({
        where: { id: activeWindow.id },
        data: {
          phase,
          reason: config.reason,
          estimatedEnd: estimatedEndDate,
          betterstackIncidentId: config.betterstackIncidentId,
          ...(phase !== "OFFLINE" ? { offlineActivatedAt: null } : {}),
        },
      });
    } else {
      row = await tx.maintenanceWindow.create({
        data: {
          phase,
          reason: config.reason,
          startedAt: new Date(),
          startedBy: config.startedBy,
          estimatedEnd: estimatedEndDate,
          bypassSecret: config.bypassSecret,
          betterstackIncidentId: config.betterstackIncidentId,
        },
      });
    }
    if (phase === MaintenancePhase.OFF && activeWindow) {
      await notifyMaintenanceEnded(
        { phase: "OFF", reason: "Maintenance completed" },
        {
          tx,
          deferAttempt: true,
          dedupeKey: `maintenance-ended:${activeWindow.id}`,
        },
      );
    } else if (phase !== MaintenancePhase.OFF && !activeWindow && row) {
      await notifyMaintenanceScheduled(
        {
          phase,
          ...(config.reason ? { reason: config.reason } : {}),
          ...(config.estimatedEnd ? { estimatedEnd: config.estimatedEnd } : {}),
        },
        {
          tx,
          deferAttempt: true,
          dedupeKey: `maintenance-scheduled:${row.id}`,
        },
      );
    }
    const actor = config.startedBy ?? config.endedBy;
    if (actor && row) {
      await recordOpsAction(tx, {
        actorUserId: actor,
        actorRole: "ADMIN",
        surface: "maintenance.manage",
        action: "maintenance.transition",
        targetKind: "MaintenanceWindow",
        targetId: row.id,
        reason: config.auditReason ?? config.reason ?? "Maintenance recovery",
        before: { phase: activeWindow?.phase ?? "OFF" },
        after: { phase },
      });
    }
    return row;
  });

  try {
    await redis.set(
      REDIS_KEYS.CONFIG,
      JSON.stringify({
        reason: window?.reason ?? null,
        estimatedEnd: window?.estimatedEnd?.toISOString() ?? null,
        bypassSecret: window?.bypassSecret ?? null,
        betterstackIncidentId: window?.betterstackIncidentId ?? null,
      }),
    );
    await redis.set(REDIS_KEYS.PHASE, phase);
  } finally {
    invalidateMaintenancePhaseCache();
  }
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
