import { NextResponse } from "next/server";

import { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";

/**
 * GET /api/admin/maintenance/preflight
 *
 * Returns pre-maintenance readiness data so admins can make an informed
 * decision before activating maintenance mode.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const fourHoursFromNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  const [
    activeCalls,
    pendingPayments,
    upcomingAppointments,
    pendingPayouts,
    openDisputes,
  ] = await Promise.all([
    prisma.meetingSession.count({ where: { endedAt: null } }),
    prisma.payment.count({ where: { paymentStatus: "PENDING" } }),
    prisma.slotOfAppointment.count({
      where: {
        startsAt: { gte: now, lte: fourHoursFromNow },
        isTentative: false,
      },
    }),
    prisma.payout.count({ where: { status: "PENDING" } }),
    prisma.dispute.count({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
      },
    }),
  ]);

  const warnings: string[] = [];
  if (activeCalls > 0)
    warnings.push(`${activeCalls} active video call(s) in progress`);
  if (pendingPayments > 0)
    warnings.push(`${pendingPayments} pending payment(s) in flight`);
  if (upcomingAppointments > 0)
    warnings.push(`${upcomingAppointments} appointment(s) in the next 4 hours`);
  if (pendingPayouts > 0) warnings.push(`${pendingPayouts} pending payout(s)`);
  if (openDisputes > 0)
    warnings.push(`${openDisputes} open dispute(s) requiring response`);

  let recommendation: "SAFE" | "CAUTION" | "RISKY";
  if (activeCalls > 0 || pendingPayments > 0 || openDisputes > 0) {
    recommendation = "RISKY";
  } else if (upcomingAppointments > 0 || pendingPayouts > 0) {
    recommendation = "CAUTION";
  } else {
    recommendation = "SAFE";
  }

  return NextResponse.json({
    activeCalls,
    pendingPayments,
    upcomingAppointments,
    pendingPayouts,
    openDisputes,
    recommendation,
    warnings,
    checkedAt: now.toISOString(),
  });
}
