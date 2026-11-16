/**
 * Back-office Metrics API: support-queue health plus the platform's people,
 * session and money totals, for ADMIN and STAFF alike (`analytics.read`).
 * Every "today", "this week" and "this month" figure counts from an IST start.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getPlatformTotals } from "@/lib/backoffice/platform-totals";
import { operatorPeriodStarts } from "@/lib/time/operator-zone";

export async function GET() {
  try {
    const auth = await requireBackofficeSurface("analytics.read");
    if (auth.error) return auth.error;

    const requestedAt = new Date();
    const {
      day: startOfToday,
      week: startOfWeek,
      month: startOfMonth,
    } = operatorPeriodStarts(requestedAt);

    // Fetch analytics data in parallel
    const [
      ticketsResolvedToday,
      ticketsResolvedThisWeek,
      ticketsResolvedThisMonth,
      openTickets,
      usersHelpedThisWeek,
      activeUsers,
      totalAppointments,
      pendingAppointments,
      platformTotals,
    ] = await Promise.all([
      // Tickets resolved today
      prisma.supportCase.count({
        where: {
          deletedAt: null,
          status: "RESOLVED",
          updatedAt: { gte: startOfToday },
        },
      }),
      // Tickets resolved this week
      prisma.supportCase.count({
        where: {
          deletedAt: null,
          status: "RESOLVED",
          updatedAt: { gte: startOfWeek },
        },
      }),
      // Tickets resolved this month
      prisma.supportCase.count({
        where: {
          deletedAt: null,
          status: "RESOLVED",
          updatedAt: { gte: startOfMonth },
        },
      }),
      // Open tickets
      prisma.supportCase.count({
        where: {
          deletedAt: null,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      }),
      // Unique users helped this week (distinct users who had tickets resolved)
      prisma.supportCase
        .findMany({
          where: {
            deletedAt: null,
            status: "RESOLVED",
            updatedAt: { gte: startOfWeek },
          },
          select: { requesterUserId: true },
          distinct: ["requesterUserId"],
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
      // Total appointments
      prisma.appointment.count(),
      // Appointments with pending payments
      prisma.payment.count({
        where: {
          paymentStatus: "PENDING",
        },
      }),
      getPlatformTotals(requestedAt),
    ]);

    // Measure the first human reply rather than unrelated later edits.
    const recentResolvedTickets = await prisma.supportCase.findMany({
      where: {
        deletedAt: null,
        firstAgentReplyAt: { not: null },
        status: "RESOLVED",
        updatedAt: { gte: startOfWeek },
      },
      select: {
        createdAt: true,
        receivedAt: true,
        firstAgentReplyAt: true,
      },
      take: 100,
    });

    let avgResponseTimeHours = 0;
    if (recentResolvedTickets.length > 0) {
      const totalHours = recentResolvedTickets.reduce((sum, ticket) => {
        const diffMs =
          (ticket.firstAgentReplyAt ?? ticket.createdAt).getTime() -
          (ticket.receivedAt ?? ticket.createdAt).getTime();
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
      },
      platformMetrics: {
        totalAppointments,
        pendingPayments: pendingAppointments,
      },
      platformTotals,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching staff analytics:", error);
    return NextResponse.json(
      { error: "Failed to fetch analytics" },
      { status: 500 },
    );
  }
}
