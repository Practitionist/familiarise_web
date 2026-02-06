/**
 * Cancellation Analytics API
 * Admin-only endpoint for cancellation insights
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole, CancellationReason } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/admin/analytics/cancellations
 * Returns aggregated cancellation data
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check admin role
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const startDateParam = searchParams.get("startDate");
    const endDateParam = searchParams.get("endDate");

    // Default to last 90 days if no dates provided
    const endDate = endDateParam ? new Date(endDateParam) : new Date();
    const startDate = startDateParam
      ? new Date(startDateParam)
      : new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Get cancelled consultations with reasons
    const cancelledConsultations = await prisma.consultation.findMany({
      where: {
        requestStatus: "CANCELLED",
        cancelledAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        id: true,
        cancellationReason: true,
        cancelledAt: true,
        cancelledBy: true,
        createdAt: true,
        consultationPlan: {
          select: {
            price: true,
            priceCurrency: true,
          },
        },
      },
    });

    // Get cancelled subscriptions with reasons
    const cancelledSubscriptions = await prisma.subscription.findMany({
      where: {
        requestStatus: "CANCELLED",
        cancelledAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        id: true,
        cancellationReason: true,
        cancelledAt: true,
        cancelledBy: true,
        createdAt: true,
        subscriptionPlan: {
          select: {
            price: true,
            priceCurrency: true,
          },
        },
      },
    });

    // Combine all cancellations
    const allCancellations = [
      ...cancelledConsultations.map((c) => ({
        ...c,
        type: "CONSULTATION" as const,
        price: c.consultationPlan.price,
        currency: c.consultationPlan.priceCurrency,
      })),
      ...cancelledSubscriptions.map((s) => ({
        ...s,
        type: "SUBSCRIPTION" as const,
        price: s.subscriptionPlan.price,
        currency: s.subscriptionPlan.priceCurrency,
      })),
    ];

    // Calculate totals
    const totalCancellations = allCancellations.length;

    // Get total bookings in period for cancellation rate
    const [totalConsultations, totalSubscriptions] = await Promise.all([
      prisma.consultation.count({
        where: {
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
      }),
      prisma.subscription.count({
        where: {
          createdAt: {
            gte: startDate,
            lte: endDate,
          },
        },
      }),
    ]);

    const totalBookings = totalConsultations + totalSubscriptions;
    const cancellationRate =
      totalBookings > 0
        ? ((totalCancellations / totalBookings) * 100).toFixed(1)
        : "0";

    // Count by reason
    const reasonCounts: Record<string, number> = {};
    for (const cancellation of allCancellations) {
      const reason = cancellation.cancellationReason || "NOT_SPECIFIED";
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    const byReason = Object.entries(reasonCounts)
      .map(([reason, count]) => ({
        reason,
        count,
        percentage:
          totalCancellations > 0
            ? ((count / totalCancellations) * 100).toFixed(1)
            : "0",
      }))
      .sort((a, b) => b.count - a.count);

    // Count by type
    const byType = {
      CONSULTATION: allCancellations.filter((c) => c.type === "CONSULTATION")
        .length,
      SUBSCRIPTION: allCancellations.filter((c) => c.type === "SUBSCRIPTION")
        .length,
    };

    // Group by month
    const byMonth: Record<string, number> = {};
    for (const cancellation of allCancellations) {
      if (cancellation.cancelledAt) {
        const month = new Date(cancellation.cancelledAt)
          .toISOString()
          .slice(0, 7);
        byMonth[month] = (byMonth[month] || 0) + 1;
      }
    }

    const monthlyTrend = Object.entries(byMonth)
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Calculate potential refund amount (sum of cancelled booking values)
    const potentialRefundAmount = allCancellations.reduce(
      (sum, c) => sum + (c.price || 0),
      0,
    );

    // Get actual refunds in period
    const refunds = await prisma.refund.aggregate({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        status: "SUCCEEDED",
      },
      _sum: {
        amount: true,
      },
      _count: true,
    });

    // Recent cancellations - single loop for both 7 and 30 day counts
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let last7Days = 0;
    let last30Days = 0;

    for (const c of allCancellations) {
      if (c.cancelledAt) {
        const cancelDate = new Date(c.cancelledAt);
        if (cancelDate >= thirtyDaysAgo) {
          last30Days++;
          if (cancelDate >= sevenDaysAgo) {
            last7Days++;
          }
        }
      }
    }

    return NextResponse.json({
      summary: {
        totalCancellations,
        cancellationRate: `${cancellationRate}%`,
        totalBookingsInPeriod: totalBookings,
        potentialRefundAmount,
        actualRefundedAmount: refunds._sum.amount || 0,
        refundCount: refunds._count,
      },
      byReason,
      byType,
      monthlyTrend,
      recentTrend: {
        last7Days,
        last30Days,
        total: totalCancellations,
      },
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      // Include available reasons for UI dropdown
      availableReasons: Object.values(CancellationReason),
    });
  } catch (error) {
    console.error("Error fetching cancellation analytics:", error);
    return NextResponse.json(
      { error: "Failed to fetch cancellation analytics" },
      { status: 500 },
    );
  }
}
