/**
 * Org analytics — high-level stat cards for the dashboard analytics page.
 *
 * GET — ORG_MANAGER+. Returns counts and aggregates that the analytics page
 * needs without expensive joins. Charting data (timeseries) lives in a future
 * deeper analytics endpoint deferred to a separate PR.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_MANAGER");
    if (access.error) return access.error;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      memberCount,
      learnerCount,
      planCount,
      monthBookings,
      lastMonthBookings,
      monthGross,
    ] = await Promise.all([
      prisma.organizationMemberProfile.count({
        where: {
          organizationProfileId: access.org.id,
          status: "ACTIVE",
        },
      }),
      prisma.organizationMemberProfile.count({
        where: {
          organizationProfileId: access.org.id,
          role: "ORG_LEARNER",
          status: "ACTIVE",
        },
      }),
      prisma.organizationPlan.count({
        where: {
          organizationProfileId: access.org.id,
          isActive: true,
        },
      }),
      prisma.payment.count({
        where: {
          organizationProfileId: access.org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: monthStart },
        },
      }),
      prisma.payment.count({
        where: {
          organizationProfileId: access.org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: lastMonthStart, lt: monthStart },
        },
      }),
      prisma.payment.aggregate({
        where: {
          organizationProfileId: access.org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
    ]);

    return NextResponse.json({
      members: { total: memberCount, learners: learnerCount },
      plans: { active: planCount },
      bookings: {
        monthToDate: monthBookings,
        lastMonth: lastMonthBookings,
        deltaPct: lastMonthBookings
          ? ((monthBookings - lastMonthBookings) / lastMonthBookings) * 100
          : null,
      },
      revenue: {
        monthToDateGross: monthGross._sum.amount ?? 0,
      },
      seatsTotal: access.org.seatsTotal,
      seatsUsed: access.org.seatsUsed,
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/analytics GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch analytics" },
      { status: 500 },
    );
  }
}
