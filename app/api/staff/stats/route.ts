/**
 * Staff Dashboard Stats API
 * Returns homepage statistics for staff dashboard
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, SupportTicketStatus } from "@prisma/client";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check staff or admin role
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Calculate date ranges
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 7);

    // Fetch all stats in parallel
    const [
      openTickets,
      resolvedThisWeek,
      pendingReviews,
      resolvedToday,
      recentTickets,
    ] = await Promise.all([
      // Open tickets count
      prisma.supportTicket.count({
        where: { status: SupportTicketStatus.OPEN },
      }),

      // Tickets resolved this week (users assisted)
      prisma.supportTicket.count({
        where: {
          status: {
            in: [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED],
          },
          updatedAt: { gte: weekStart },
        },
      }),

      // Pending consultant reviews
      prisma.consultantReview.count({
        where: {
          createdAt: { gte: weekStart },
        },
      }),

      // Tickets resolved today
      prisma.supportTicket.count({
        where: {
          status: {
            in: [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED],
          },
          updatedAt: { gte: todayStart },
        },
      }),

      // Recent open/in-progress tickets (last 4)
      prisma.supportTicket.findMany({
        where: {
          status: {
            in: [SupportTicketStatus.OPEN, SupportTicketStatus.IN_PROGRESS],
          },
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        take: 4,
      }),
    ]);

    // Format recent tickets for frontend
    const formattedRecentTickets = recentTickets.map((ticket) => ({
      id: ticket.id,
      subject: ticket.title,
      user: ticket.user.name || ticket.user.email || "Unknown",
      userImage: ticket.user.image,
      status: ticket.status.toLowerCase(),
      priority: ticket.priority.toLowerCase(),
      createdAt: ticket.createdAt,
    }));

    return NextResponse.json({
      openTickets,
      usersAssisted: resolvedThisWeek,
      pendingReviews,
      resolvedToday,
      recentTickets: formattedRecentTickets,
    });
  } catch (error) {
    console.error("Error fetching staff stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch staff stats" },
      { status: 500 },
    );
  }
}
