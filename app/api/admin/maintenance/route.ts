import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { MaintenancePhase, UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { getMaintenanceState, setMaintenanceState } from "@/lib/maintenance";
import prisma from "@/lib/prisma";

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
  const { phase, reason, estimatedEnd } = body as {
    phase?: string;
    reason?: string;
    estimatedEnd?: string;
  };

  const targetPhase =
    phase === "DEGRADED"
      ? MaintenancePhase.DEGRADED
      : MaintenancePhase.OFFLINE;

  const bypassSecret = crypto.randomUUID();

  await setMaintenanceState(targetPhase, {
    reason,
    estimatedEnd,
    bypassSecret,
    startedBy: auth.userId,
  });

  return NextResponse.json({
    phase: targetPhase,
    bypassSecret,
    message: `Maintenance mode set to ${targetPhase}`,
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

  await setMaintenanceState(MaintenancePhase.OFF, {
    endedBy: auth.userId,
  });

  return NextResponse.json({
    phase: "OFF",
    message: "Maintenance mode ended",
  });
}
