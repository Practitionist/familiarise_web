/**
 * Staff Reports Team API
 * Team leaderboard and performance metrics
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/reports/team
 * Get team performance leaderboard
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const days = parseInt(searchParams.get("days") || "7");

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Get all staff users
    const staffUsers = await prisma.user.findMany({
      where: { role: UserRole.STAFF },
      select: { id: true, name: true, email: true, image: true },
    });

    // Get ticket resolution counts per staff
    const resolutionCounts = await prisma.supportTicket.groupBy({
      by: ["assignedToId"],
      where: {
        status: { in: ["RESOLVED", "CLOSED"] },
        updatedAt: { gte: startDate },
        assignedToId: { not: null },
      },
      _count: { id: true },
    });

    // Get active ticket counts per staff
    const activeCounts = await prisma.supportTicket.groupBy({
      by: ["assignedToId"],
      where: {
        status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] },
        assignedToId: { not: null },
      },
      _count: { id: true },
    });

    const resolutionMap = new Map(
      resolutionCounts.map((r) => [r.assignedToId, r._count.id])
    );
    const activeMap = new Map(
      activeCounts.map((a) => [a.assignedToId, a._count.id])
    );

    // Build leaderboard
    const leaderboard = staffUsers
      .map((staff) => ({
        id: staff.id,
        name: staff.name || staff.email || "Unknown",
        image: staff.image,
        ticketsResolved: resolutionMap.get(staff.id) || 0,
        activeTickets: activeMap.get(staff.id) || 0,
        // Could add more metrics like avg resolution time, satisfaction, etc.
      }))
      .sort((a, b) => b.ticketsResolved - a.ticketsResolved);

    return NextResponse.json({
      leaderboard,
      period: { days, startDate, endDate: new Date() },
    });
  } catch (error) {
    console.error("Error fetching team reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch team reports" },
      { status: 500 }
    );
  }
}
