/**
 * Staff Analytics API
 * Limited analytics metrics for staff members (excludes revenue data)
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

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

    if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date();
    const startOfToday = new Date(now.setHours(0, 0, 0, 0));
    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch analytics data in parallel
    const [
      ticketsResolvedToday,
      ticketsResolvedThisWeek,
      ticketsResolvedThisMonth,
      openTickets,
      usersHelpedThisWeek,
      activeUsers,
      newSignupsThisMonth,
      totalUsers,
      totalAppointments,
      pendingAppointments,
    ] = await Promise.all([
      // Tickets resolved today
      prisma.supportTicket.count({
        where: {
          status: "RESOLVED",
          updatedAt: { gte: startOfToday },
        },
      }),
      // Tickets resolved this week
      prisma.supportTicket.count({
        where: {
          status: "RESOLVED",
          updatedAt: { gte: startOfWeek },
        },
      }),
      // Tickets resolved this month
      prisma.supportTicket.count({
        where: {
          status: "RESOLVED",
          updatedAt: { gte: startOfMonth },
        },
      }),
      // Open tickets
      prisma.supportTicket.count({
        where: {
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      }),
      // Unique users helped this week (distinct users who had tickets resolved)
      prisma.supportTicket
        .findMany({
          where: {
            status: "RESOLVED",
            updatedAt: { gte: startOfWeek },
          },
          select: { userId: true },
          distinct: ["userId"],
        })
        .then((tickets) => tickets.length),
      // Active users (users with payments this month)
      prisma.payment
        .findMany({
          where: {
            createdAt: { gte: startOfMonth },
          },
          select: { userId: true },
          distinct: ["userId"],
        })
        .then((payments) => payments.length),
      // New signups this month
      prisma.user.count({
        where: {
          createdAt: { gte: startOfMonth },
        },
      }),
      // Total users
      prisma.user.count(),
      // Total appointments
      prisma.appointment.count(),
      // Appointments with pending payments
      prisma.payment.count({
        where: {
          paymentStatus: "PENDING",
        },
      }),
    ]);

    // Calculate average response time (simplified - time from ticket creation to first update)
    const recentResolvedTickets = await prisma.supportTicket.findMany({
      where: {
        status: "RESOLVED",
        updatedAt: { gte: startOfWeek },
      },
      select: {
        createdAt: true,
        updatedAt: true,
      },
      take: 100,
    });

    let avgResponseTimeHours = 0;
    if (recentResolvedTickets.length > 0) {
      const totalHours = recentResolvedTickets.reduce((sum, ticket) => {
        const diffMs =
          new Date(ticket.updatedAt).getTime() -
          new Date(ticket.createdAt).getTime();
        return sum + diffMs / (1000 * 60 * 60);
      }, 0);
      avgResponseTimeHours =
        Math.round((totalHours / recentResolvedTickets.length) * 10) / 10;
    }

    return NextResponse.json({
      supportMetrics: {
        ticketsResolvedToday,
        ticketsResolvedThisWeek,
        ticketsResolvedThisMonth,
        openTickets,
        avgResponseTimeHours,
      },
      userMetrics: {
        usersHelpedThisWeek,
        activeUsers,
        newSignupsThisMonth,
        totalUsers,
      },
      platformMetrics: {
        totalAppointments,
        pendingPayments: pendingAppointments,
      },
    });
  } catch (error) {
    console.error("Error fetching staff analytics:", error);
    return NextResponse.json(
      { error: "Failed to fetch analytics" },
      { status: 500 },
    );
  }
}
