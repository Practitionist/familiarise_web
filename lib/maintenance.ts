/**
 * Maintenance Mode Library (Node.js reader & writer)
 */

import { MaintenancePhase } from "@prisma/client";

import prisma from "@/lib/prisma";
import redis from "@/lib/redis";
import {
  recordOpsAction,
  type OpsActor,
} from "@/lib/backoffice/ops-action-log";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import { invalidateMaintenancePhaseCache } from "@/lib/maintenance-cron";
import { mayWriteProductionState } from "@/lib/production-state";

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
 * Set maintenance state in Redis and persist to Prisma. The window row and its
 * Redis mirror are production state, so another deploy writes neither.
 * Every transition is audited against the operator who made it.
 */
export async function setMaintenanceState(
  phase: MaintenancePhase,
  config: {
    actor: OpsActor;
    reason?: string;
    estimatedEnd?: string;
    bypassSecret?: string;
    betterstackIncidentId?: string | null;
    auditReason?: string;
  },
): Promise<void> {
  if (!mayWriteProductionState(REDIS_KEYS.PHASE)) return;
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
          endedBy: config.actor.userId,
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
          startedBy: config.actor.userId,
          estimatedEnd: estimatedEndDate,
          bypassSecret: config.bypassSecret,
          betterstackIncidentId: config.betterstackIncidentId,
        },
      });
    }
    if (row) {
      await recordOpsAction(tx, {
        actorUserId: config.actor.userId,
        actorRole: config.actor.role,
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
