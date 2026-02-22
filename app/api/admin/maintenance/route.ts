import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { MaintenancePhase, UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { createIncident, resolveIncident } from "@/lib/betterstack";
import { getMaintenanceState, setMaintenanceState } from "@/lib/maintenance";
import prisma from "@/lib/prisma";
import { freezeAppointments } from "@/actions/maintenance/freeze-appointments";
import { runPostRecovery } from "@/actions/maintenance/post-recovery";

async function requireAdmin() {
  const session = await getSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { userId: session.user.id };
}

/**
 * GET /api/admin/maintenance
 * Returns current maintenance state + recent maintenance windows.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const [state, recentWindows] = await Promise.all([
    getMaintenanceState(),
    prisma.maintenanceWindow.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return NextResponse.json({ state, history: recentWindows });
}

/**
 * POST /api/admin/maintenance
 * Start maintenance mode.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const body = await request.json();
  const { phase, reason, estimatedEnd, bypassDisputeCheck } = body as {
    phase?: string;
    reason?: string;
    estimatedEnd?: string;
    bypassDisputeCheck?: boolean;
  };

  // Block if open disputes have response deadlines within the maintenance window (+48h buffer)
  if (estimatedEnd && !bypassDisputeCheck) {
    const bufferEnd = new Date(new Date(estimatedEnd).getTime() + 48 * 60 * 60 * 1000);
    const urgentDisputes = await prisma.dispute.findMany({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
        dueBy: { gte: new Date(), lte: bufferEnd },
      },
      select: { id: true, dueBy: true, amount: true, currency: true },
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

  const targetPhase =
    phase === "DEGRADED"
      ? MaintenancePhase.DEGRADED
      : MaintenancePhase.OFFLINE;

  const bypassSecret = crypto.randomUUID();

  let betterstackIncidentId: string | null = null;
  if (targetPhase === MaintenancePhase.OFFLINE) {
    betterstackIncidentId = await createIncident(
      "Platform Maintenance",
      reason || "Scheduled platform maintenance in progress",
    );
  }

  await setMaintenanceState(targetPhase, {
    reason,
    estimatedEnd,
    bypassSecret,
    startedBy: auth.userId,
    betterstackIncidentId: betterstackIncidentId ?? undefined,
  });

  let freezeResult: Awaited<ReturnType<typeof freezeAppointments>> | undefined;
  if (targetPhase === MaintenancePhase.OFFLINE) {
    const start = new Date();
    const end = estimatedEnd ? new Date(estimatedEnd) : null;
    freezeResult = await freezeAppointments(start, end);
  }

  return NextResponse.json({
    phase: targetPhase,
    bypassSecret,
    betterstackIncidentId,
    message: `Maintenance mode set to ${targetPhase}`,
    ...(freezeResult !== undefined ? { freeze: freezeResult } : {}),
  });
}

/**
 * PATCH /api/admin/maintenance
 * Update maintenance phase or config (e.g., transition DEGRADED ↔ OFFLINE, update ETA).
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const body = await request.json();
  const { phase, reason, estimatedEnd } = body as {
    phase?: string;
    reason?: string;
    estimatedEnd?: string;
  };

  const currentState = await getMaintenanceState();
  if (currentState.phase === "OFF") {
    return NextResponse.json(
      { error: "No active maintenance window to update. Use POST to start one." },
      { status: 400 },
    );
  }

  const targetPhase = phase
    ? (phase as MaintenancePhase)
    : currentState.phase;

  await setMaintenanceState(targetPhase, {
    reason: reason ?? currentState.reason ?? undefined,
    estimatedEnd: estimatedEnd ?? currentState.estimatedEnd ?? undefined,
    bypassSecret: currentState.bypassSecret ?? undefined,
  });

  return NextResponse.json({
    phase: targetPhase,
    message: `Maintenance updated to ${targetPhase}`,
  });
}

/**
 * DELETE /api/admin/maintenance
 * End maintenance mode (set phase=OFF).
 */
export async function DELETE() {
  const auth = await requireAdmin();
  if ("error" in auth && auth.error) return auth.error;

  const currentState = await getMaintenanceState();

  if (currentState.betterstackIncidentId) {
    await resolveIncident(currentState.betterstackIncidentId);
  }

  await setMaintenanceState(MaintenancePhase.OFF, {
    endedBy: auth.userId,
  });

  const recoveryResult = await runPostRecovery();
  return NextResponse.json({
    phase: "OFF",
    message: "Maintenance mode ended",
    recovery: recoveryResult,
  });
}
