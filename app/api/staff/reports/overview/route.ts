/**
 * Staff Reports Overview API
 * Dashboard stats for staff performance
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/reports/overview
 * Get dashboard overview statistics
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
    const staffId = searchParams.get("staffId") || session.user.id;

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const previousStartDate = new Date(
      Date.now() - days * 2 * 24 * 60 * 60 * 1000
    );

    // Current period stats
    const [
      ticketsResolved,
      activeTickets,
      previousTicketsResolved,
    ] = await Promise.all([
      // Tickets resolved in current period
      prisma.supportTicket.count({
        where: {
          assignedToId: staffId,
          status: { in: ["RESOLVED", "CLOSED"] },
          updatedAt: { gte: startDate },
        },
      }),
      // Active tickets
      prisma.supportTicket.count({
        where: {
          assignedToId: staffId,
          status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] },
        },
      }),
      // Previous period for comparison
      prisma.supportTicket.count({
        where: {
          assignedToId: staffId,
          status: { in: ["RESOLVED", "CLOSED"] },
          updatedAt: { gte: previousStartDate, lt: startDate },
        },
      }),
    ]);

    // Calculate average resolution time (simplified - based on updatedAt - createdAt)
    const resolvedTickets = await prisma.supportTicket.findMany({
      where: {
        assignedToId: staffId,
        status: { in: ["RESOLVED", "CLOSED"] },
        updatedAt: { gte: startDate },
      },
      select: { createdAt: true, updatedAt: true },
    });

    let avgResolutionHours = 0;
    if (resolvedTickets.length > 0) {
      const totalMs = resolvedTickets.reduce(
        (sum, ticket) =>
          sum + (ticket.updatedAt.getTime() - ticket.createdAt.getTime()),
        0
      );
      avgResolutionHours = Math.round(
        totalMs / resolvedTickets.length / (1000 * 60 * 60) * 10
      ) / 10;
    }

    // Calculate change percentages
    const ticketsChange =
      previousTicketsResolved > 0
        ? Math.round(
            ((ticketsResolved - previousTicketsResolved) / previousTicketsResolved) *
              100
          )
        : 0;

    return NextResponse.json({
      stats: {
        ticketsResolved: {
          value: ticketsResolved,
          change: ticketsChange,
          trend: ticketsChange >= 0 ? "up" : "down",
        },
        avgResolutionTime: {
          value: `${avgResolutionHours}h`,
          change: 0, // Would need historical data for comparison
          trend: "neutral",
        },
        activeTickets: {
          value: activeTickets,
          change: 0,
          trend: "neutral",
        },
        customerSatisfaction: {
          value: "N/A", // Would need rating data
          change: 0,
          trend: "neutral",
        },
      },
      period: {
        days,
        startDate,
        endDate: new Date(),
      },
    });
  } catch (error) {
    console.error("Error fetching reports overview:", error);
    return NextResponse.json(
      { error: "Failed to fetch overview" },
      { status: 500 }
    );
  }
}
