import {
  drainActiveSessions,
  unfreezeChannelsAfterMaintenance,
} from "@/actions/maintenance/drain-sessions";
import { pauseDiscountCodes } from "@/actions/maintenance/pause-discount-codes";
import { runPostRecovery } from "@/actions/maintenance/post-recovery";
import { MaintenancePhase, Prisma } from "@prisma/client";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createIncident, resolveIncident } from "@/lib/betterstack";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import {
  opsActorOf,
  recordOpsAction,
  type OpsActor,
} from "@/lib/backoffice/ops-action-log";
import {
  getMaintenanceState,
  setMaintenanceState,
  type MaintenanceState,
} from "@/lib/maintenance";
import { signMaintenanceBypassCookie } from "@/lib/maintenance-edge";
import { REDIS_KEYS } from "@/lib/maintenance-keys";
import { mayWriteProductionState } from "@/lib/production-state";
import prisma from "@/lib/prisma";
import {
  withCronLock,
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/with-cron-lock";
import { captureThrottled } from "@/lib/observability/throttled-capture";

async function requireOperator() {
  const result = await requireBackofficeSurface("maintenance.manage");
  if (result.error) return { error: result.error };
  return { actor: opsActorOf(result.session) };
}

// Ended windows are history: their bypass secrets and incident ids stay server-side.
const historySelect = {
  id: true,
  phase: true,
  reason: true,
  scheduledAt: true,
  startedAt: true,
  endedAt: true,
  estimatedEnd: true,
  startedBy: true,
  endedBy: true,
  offlineActivatedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaintenanceWindowSelect;

const postSchema = z.object({
  phase: z.enum(["DEGRADED", "OFFLINE"]),
  reason: z.string().trim().min(5).max(1000),
  estimatedEnd: z.string().datetime({ offset: true }).optional(),
  bypassDisputeCheck: z.boolean().optional(),
});

const patchSchema = z.object({
  phase: z.enum(["DEGRADED", "OFFLINE"]).optional(),
  reason: z.string().trim().min(5).max(1000),
  estimatedEnd: z.string().datetime({ offset: true }).optional(),
});
const endSchema = z.object({ reason: z.string().trim().min(5).max(1000) });

async function activateOffline(actor: OpsActor, reason: string) {
  const window = await prisma.maintenanceWindow.findFirstOrThrow({
    where: { organizationId: null, phase: "OFFLINE" },
    orderBy: { createdAt: "desc" },
  });
  if (window.offlineActivatedAt) return null;
  const discounts = await pauseDiscountCodes();
  const drain = await drainActiveSessions();
  if (
    drain.errors.length ||
    drain.remainingSessions ||
    drain.remainingChannelFreezes
  )
    return NextResponse.json(
      {
        error:
          "OFFLINE setup is incomplete. Retry activation before starting schema work.",
        phase: "OFFLINE",
        setup: drain,
      },
      { status: 503 },
    );
  const activatedAt = new Date();
  // One audit row per activation: only the request whose CAS stamps the window writes it.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.maintenanceWindow.updateMany({
      where: { id: window.id, phase: "OFFLINE", offlineActivatedAt: null },
      data: { offlineActivatedAt: activatedAt },
    });
    if (count === 0) return;
    await recordOpsAction(tx, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      surface: "maintenance.manage",
      action: "maintenance.offline-activated",
      targetKind: "MaintenanceWindow",
      targetId: window.id,
      reason,
      before: { offlineActivatedAt: null },
      after: {
        offlineActivatedAt: activatedAt.toISOString(),
        discountCodesPaused: discounts.paused,
        sessionsDrained: drain.drained,
        recordingsStopped: drain.recordingsStopped,
      },
    });
  });
  return null;
}

/**
 * GET /api/admin/maintenance
 * Returns current maintenance state + recent maintenance windows.
 */
export async function GET() {
  const auth = await requireOperator();
  if (auth.error) return auth.error;

  const [state, recentWindows] = await Promise.all([
    getMaintenanceState(),
    prisma.maintenanceWindow.findMany({
      where: { organizationId: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: historySelect,
    }),
  ]);

  const bypassCookieToken = state.bypassSecret
    ? await signMaintenanceBypassCookie(state.bypassSecret)
    : null;

  return NextResponse.json({
    state: { ...state, bypassCookieToken },
    bypassCookieToken,
    history: recentWindows,
  });
}

async function retryMaintenanceActivation(
  currentState: MaintenanceState,
  targetPhase: z.infer<typeof postSchema>["phase"],
  reason: string,
  actor: OpsActor,
) {
  if (currentState.phase !== targetPhase)
    return NextResponse.json(
      { error: "Use PATCH to change the active phase" },
      { status: 409 },
    );
  await setMaintenanceState(targetPhase, {
    reason: currentState.reason ?? reason,
    auditReason: reason,
    estimatedEnd: currentState.estimatedEnd ?? undefined,
    bypassSecret: currentState.bypassSecret ?? undefined,
    betterstackIncidentId: currentState.betterstackIncidentId,
    actor,
  });
  if (targetPhase === "OFFLINE") {
    const incomplete = await activateOffline(actor, reason);
    if (incomplete) return incomplete;
  }
  return NextResponse.json({
    ...currentState,
    bypassCookieToken: currentState.bypassSecret
      ? await signMaintenanceBypassCookie(currentState.bypassSecret)
      : null,
  });
}

/**
 * POST /api/admin/maintenance
 * Start maintenance mode.
 */
async function startMaintenance(request: NextRequest) {
  const auth = await requireOperator();
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }
  const { phase, reason, estimatedEnd, bypassDisputeCheck } = parsed.data;
  const estimatedEndDate = estimatedEnd ? new Date(estimatedEnd) : null;

  // Block if open disputes have response deadlines within the maintenance window (+48h buffer)
  if (estimatedEndDate && !bypassDisputeCheck) {
    const bufferEnd = new Date(
      estimatedEndDate.getTime() + 48 * 60 * 60 * 1000,
    );
    const urgentDisputes = await prisma.dispute.findMany({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
        dueBy: { gte: new Date(), lte: bufferEnd },
      },
      select: { id: true, dueBy: true, amountPaise: true, currency: true },
      orderBy: { dueBy: "asc" },
    });
    if (urgentDisputes.length > 0) {
      return NextResponse.json(
        {
          error: `${urgentDisputes.length} dispute(s) have response deadlines within the maintenance window. Resolve them first or pass bypassDisputeCheck: true to override.`,
          disputes: urgentDisputes,
        },
        { status: 409 },
      );
    }
  }

  const targetPhase = phase;
  const currentState = await getMaintenanceState();
  if (currentState.phase !== "OFF") {
    return retryMaintenanceActivation(
      currentState,
      targetPhase,
      reason,
      auth.actor,
    );
  }
  const bypassSecret = crypto.randomUUID();
  const bypassCookieToken = await signMaintenanceBypassCookie(bypassSecret);
  const betterstackIncidentId =
    targetPhase === "OFFLINE"
      ? await createIncident("Platform Maintenance", reason)
      : null;

  await setMaintenanceState(targetPhase, {
    reason,
    estimatedEnd: estimatedEndDate?.toISOString(),
    bypassSecret,
    actor: auth.actor,
    betterstackIncidentId,
  });

  if (targetPhase === "OFFLINE") {
    const incomplete = await activateOffline(auth.actor, reason);
    if (incomplete) return incomplete;
  }
  return NextResponse.json({
    phase: targetPhase,
    bypassSecret,
    bypassCookieToken,
    betterstackIncidentId,
  });
}

async function recoverOfflineMaintenance(currentState: MaintenanceState) {
  if (!currentState.offlineActivatedAt)
    return NextResponse.json(
      {
        error:
          "Finish Retry Offline Setup before recovery so uncertain vendor operations are acknowledged.",
      },
      { status: 503 },
    );
  const recovery = await runPostRecovery();
  const chat = await unfreezeChannelsAfterMaintenance();
  if (
    recovery.errors.length ||
    !recovery.database ||
    !recovery.redis ||
    chat.errors.length ||
    chat.remaining
  )
    return NextResponse.json(
      {
        error: "Recovery incomplete; OFFLINE remains active",
        recovery,
        chat,
      },
      { status: 503 },
    );
  if (currentState.betterstackIncidentId)
    await resolveIncident(currentState.betterstackIncidentId);
  return null;
}

/**
 * PATCH /api/admin/maintenance
 * Update maintenance phase or config (e.g., transition DEGRADED ↔ OFFLINE, update ETA).
 */
async function updateMaintenance(request: NextRequest) {
  const auth = await requireOperator();
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }
  const { phase, reason, estimatedEnd } = parsed.data;

  const currentState = await getMaintenanceState();
  if (currentState.phase === "OFF") {
    return NextResponse.json(
      {
        error: "No active maintenance window to update. Use POST to start one.",
      },
      { status: 400 },
    );
  }

  const currentPhase = currentState.phase;
  const targetPhase = phase ?? currentPhase;
  const nextEstimatedEnd =
    estimatedEnd === undefined
      ? (currentState.estimatedEnd ?? undefined)
      : new Date(estimatedEnd).toISOString();

  let betterstackIncidentId = currentState.betterstackIncidentId;
  if (
    currentPhase !== MaintenancePhase.OFFLINE &&
    targetPhase === MaintenancePhase.OFFLINE
  ) {
    betterstackIncidentId = await createIncident(
      "Platform Maintenance",
      reason,
    );
  } else if (
    currentPhase === MaintenancePhase.OFFLINE &&
    targetPhase !== MaintenancePhase.OFFLINE
  ) {
    const incomplete = await recoverOfflineMaintenance(currentState);
    if (incomplete) return incomplete;
    betterstackIncidentId = null;
  }

  await setMaintenanceState(targetPhase, {
    reason,
    estimatedEnd: nextEstimatedEnd,
    bypassSecret: currentState.bypassSecret ?? undefined,
    betterstackIncidentId,
    actor: auth.actor,
  });

  if (targetPhase === "OFFLINE") {
    const incomplete = await activateOffline(auth.actor, reason);
    if (incomplete) return incomplete;
  }
  return NextResponse.json({
    phase: targetPhase,
    betterstackIncidentId,
    transition: `${currentPhase} -> ${targetPhase}`,
  });
}

/**
 * DELETE /api/admin/maintenance
 * End maintenance mode (set phase=OFF).
 */
async function endMaintenance(request: NextRequest) {
  const auth = await requireOperator();
  if (auth.error) return auth.error;
  const body: unknown = await request.json().catch(() => null);
  const parsed = endSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Provide a recovery reason between 5 and 1000 characters." },
      { status: 400 },
    );
  const currentState = await getMaintenanceState();
  if (currentState.phase === "OFF") {
    await setMaintenanceState(MaintenancePhase.OFF, {
      actor: auth.actor,
      auditReason: parsed.data.reason,
    });
    return NextResponse.json({ phase: "OFF", alreadyEnded: true });
  }
  if (currentState.phase === "OFFLINE" && !currentState.offlineActivatedAt)
    return NextResponse.json(
      {
        error:
          "Finish Retry Offline Setup before recovery so uncertain vendor operations are acknowledged.",
      },
      { status: 503 },
    );
  const recovery = await runPostRecovery();
  const chat = await unfreezeChannelsAfterMaintenance();
  if (
    !recovery.database ||
    !recovery.redis ||
    recovery.errors.length ||
    chat.errors.length ||
    chat.remaining
  ) {
    return NextResponse.json(
      {
        error:
          "Recovery incomplete; maintenance remains active. Retry recovery.",
        recovery,
        chat,
      },
      { status: 503 },
    );
  }
  if (currentState.betterstackIncidentId)
    await resolveIncident(currentState.betterstackIncidentId);
  await setMaintenanceState(MaintenancePhase.OFF, {
    actor: auth.actor,
    auditReason: parsed.data.reason,
  });
  return NextResponse.json({ phase: "OFF", recovery, chat });
}

async function control(
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const auth = await requireOperator();
  if (auth.error) return auth.error;
  // Another deploy would flip production: the window, its Redis mirror and the drains are all shared.
  if (!mayWriteProductionState(REDIS_KEYS.PHASE))
    return NextResponse.json(
      {
        error: "Maintenance changes run only on the production deploy.",
        code: "MAINTENANCE_PRODUCTION_ONLY",
      },
      { status: 409 },
    );
  try {
    const result = await withCronLock(
      "maintenance-control",
      { failMode: "closed", ttlMs: 120_000 },
      async () => {
        const response = await run();
        return { success: response.ok, response };
      },
    );
    return result.response;
  } catch (error) {
    if (error instanceof CronLockHeldError)
      return NextResponse.json(
        { error: "Another maintenance change is running" },
        { status: 409 },
      );
    if (error instanceof CronLockUnavailableError)
      return NextResponse.json(
        { error: "Maintenance change lock is unavailable" },
        { status: 503 },
      );
    captureThrottled("maintenance:control", error, {
      subsystem: "maintenance",
    });
    return NextResponse.json(
      {
        error:
          "Maintenance change is incomplete. Check the current state and retry after restoring prerequisites.",
      },
      { status: 503 },
    );
  }
}
export async function POST(request: NextRequest) {
  return control(() => startMaintenance(request));
}
export async function PATCH(request: NextRequest) {
  return control(() => updateMaintenance(request));
}
export async function DELETE(request: NextRequest) {
  return control(() => endMaintenance(request));
}
