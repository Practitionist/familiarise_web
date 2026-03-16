import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole, PaymentStatus } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
export async function GET() {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Fetch stats
    const [
      totalPayments,
      pendingPayments,
      expiredPayments,
      totalRefunds,
      activeDisputes,
      totalDisputes,
      recentPayments,
      recentRefunds,
    ] = await Promise.all([
      // Total payments
      prisma.payment.count(),

      // Pending payments
      prisma.payment.count({
        where: { paymentStatus: PaymentStatus.PENDING },
      }),

      // Expired payments (abandonment tracking)
      prisma.payment.count({
        where: { paymentStatus: PaymentStatus.EXPIRED },
      }),

      // Total refunds
      prisma.refund.count(),

      // Active disputes (needs response or under review)
      prisma.dispute.count({
        where: {
          status: {
            in: ["WARNING_NEEDS_RESPONSE", "NEEDS_RESPONSE", "UNDER_REVIEW"],
          },
        },
      }),

      // Total disputes
      prisma.dispute.count(),

      // Recent payments (last 5)
      prisma.payment.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentStatus: true,
          paymentGateway: true,
          createdAt: true,
          appointment: {
            select: {
              appointmentType: true,
            },
          },
        },
      }),

      // Recent refunds (last 5)
      prisma.refund.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          paymentGateway: true,
          createdAt: true,
        },
      }),
    ]);

    // Calculate total payment value
    const paymentsAggregation = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    // Calculate pending payments value
    const pendingPaymentsAggregation = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: PaymentStatus.PENDING },
    });

    // Calculate total refunds value
    const refundsAggregation = await prisma.refund.aggregate({
      _sum: { amount: true },
    });

    // Calculate gateway stats
    const gatewayStats = await prisma.payment.groupBy({
      by: ["paymentGateway"],
      _count: true,
    });

    const formattedGatewayStats = gatewayStats.reduce(
      (acc, stat) => {
        acc[stat.paymentGateway] = { count: stat._count };
        return acc;
      },
      {} as Record<string, { count: number }>,
    );

    return NextResponse.json({
      totalPayments,
      totalPaymentsValue: paymentsAggregation._sum.amount || 0,
      pendingPayments,
      pendingPaymentsValue: pendingPaymentsAggregation._sum.amount || 0,
      expiredPayments,
      totalRefunds,
      totalRefundsValue: refundsAggregation._sum.amount || 0,
      activeDisputes,
      totalDisputes,
      recentPayments,
      recentRefunds,
      gatewayStats: formattedGatewayStats,
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    return NextResponse.json(
      { error: "Failed to fetch admin stats" },
      { status: 500 },
    );
  }
}
