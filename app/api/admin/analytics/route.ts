import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import authOptions from "../../auth/[...nextauth]/options";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify user is admin
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get current date info for time-based queries
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch user counts by role
    const [
      totalUsers,
      totalConsultants,
      totalConsultees,
      totalStaff,
      newUsersThisMonth,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: UserRole.CONSULTANT } }),
      prisma.user.count({ where: { role: UserRole.CONSULTEE } }),
      prisma.user.count({ where: { role: UserRole.STAFF } }),
      prisma.user.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
    ]);

    // Active users (completed onboarding)
    const [activeConsultants, activeConsultees] = await Promise.all([
      prisma.user.count({
        where: {
          role: UserRole.CONSULTANT,
          onboardingCompleted: true,
        },
      }),
      prisma.user.count({
        where: {
          role: UserRole.CONSULTEE,
          onboardingCompleted: true,
        },
      }),
    ]);

    // Get top domains by consultant count
    const topDomains = await prisma.domain.findMany({
      select: {
        name: true,
        _count: {
          select: { consultantProfiles: true },
        },
      },
      orderBy: {
        consultantProfiles: { _count: "desc" },
      },
      take: 5,
    });

    // Format top domains
    const formattedTopDomains = topDomains.map((domain) => ({
      name: domain.name,
      consultantCount: domain._count.consultantProfiles,
    }));

    // Session stats (appointments)
    const [
      totalSessions,
      completedSessions,
      upcomingSessions,
      cancelledSessions,
    ] = await Promise.all([
      prisma.appointment.count(),
      prisma.appointment.count({
        where: { status: "COMPLETED" },
      }),
      prisma.appointment.count({
        where: {
          status: "SCHEDULED",
          scheduledAt: { gte: now },
        },
      }),
      prisma.appointment.count({
        where: { status: "CANCELLED" },
      }),
    ]);

    // Payment stats
    const paymentStats = await prisma.payment.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { paymentStatus: "SUCCEEDED" },
    });

    const revenueThisMonth = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        paymentStatus: "SUCCEEDED",
        createdAt: { gte: startOfMonth },
      },
    });

    const refundTotal = await prisma.refund.aggregate({
      _sum: { amount: true },
      where: { status: "SUCCEEDED" },
    });

    const totalRevenue = paymentStats._sum.amount?.toNumber() || 0;
    const avgSessionValue =
      paymentStats._count > 0 ? totalRevenue / paymentStats._count : 0;

    return NextResponse.json({
      // User stats
      totalUsers,
      totalConsultants,
      totalConsultees,
      totalStaff,
      newUsersThisMonth,
      activeConsultants,
      activeConsultees,

      // Session stats
      totalSessions,
      completedSessions,
      upcomingSessions,
      cancelledSessions,

      // Revenue stats
      totalRevenue,
      revenueThisMonth: revenueThisMonth._sum.amount?.toNumber() || 0,
      avgSessionValue,
      totalRefunds: refundTotal._sum.amount?.toNumber() || 0,

      // Top domains
      topDomains: formattedTopDomains,
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
