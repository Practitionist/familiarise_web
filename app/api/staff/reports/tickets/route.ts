/**
 * Staff Reports Tickets API
 * Ticket volume and resolution metrics
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/reports/tickets
 * Get ticket volume and resolution time stats
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

    // Get daily ticket counts
    const tickets = await prisma.supportTicket.findMany({
      where: {
        createdAt: { gte: startDate },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Group by day
    const dailyData: Record<
      string,
      { tickets: number; resolved: number }
    > = {};

    // Initialize all days
    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = date.toISOString().split("T")[0];
      dailyData[key] = { tickets: 0, resolved: 0 };
    }

    // Count tickets and resolutions
    tickets.forEach((ticket) => {
      const createdKey = ticket.createdAt.toISOString().split("T")[0];
      if (dailyData[createdKey]) {
        dailyData[createdKey].tickets++;
      }

      if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
        const resolvedKey = ticket.updatedAt.toISOString().split("T")[0];
        if (dailyData[resolvedKey]) {
          dailyData[resolvedKey].resolved++;
        }
      }
    });

    // Convert to array sorted by date
    const chartData = Object.entries(dailyData)
      .map(([date, data]) => ({
        date,
        day: new Date(date).toLocaleDateString("en-US", { weekday: "short" }),
        tickets: data.tickets,
        resolved: data.resolved,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Summary stats
    const totalCreated = tickets.length;
    const totalResolved = tickets.filter(
      (t) => t.status === "RESOLVED" || t.status === "CLOSED"
    ).length;

    return NextResponse.json({
      chartData,
      summary: {
        totalCreated,
        totalResolved,
        resolutionRate:
          totalCreated > 0
            ? Math.round((totalResolved / totalCreated) * 100)
            : 0,
      },
      period: { days, startDate, endDate: new Date() },
    });
  } catch (error) {
    console.error("Error fetching ticket reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch ticket reports" },
      { status: 500 }
    );
  }
}
