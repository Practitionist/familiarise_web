/**
 * Staff Moderation Stats API
 * Moderation dashboard statistics
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/moderation/stats
 * Get moderation statistics
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

    // Get report counts
    const [
      pendingReports,
      resolvedReportsToday,
      pendingVerifications,
      totalReviews,
    ] = await Promise.all([
      prisma.moderationReport.count({
        where: { status: "PENDING" },
      }),
      prisma.moderationReport.count({
        where: {
          status: { in: ["DISMISSED", "ACTION_TAKEN"] },
          resolvedAt: { gte: startDate },
        },
      }),
      prisma.consultantProfileVerification.count({
        where: { status: "PENDING" },
      }),
      prisma.consultantReview.count(),
    ]);

    // Get report type breakdown
    const reportsByType = await prisma.moderationReport.groupBy({
      by: ["type"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    // Get action type breakdown
    const actionsByType = await prisma.moderationAction.groupBy({
      by: ["actionType"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    return NextResponse.json({
      stats: {
        pendingReports,
        resolvedReports: resolvedReportsToday,
        pendingVerifications,
        totalReviews,
      },
      reportsByType: reportsByType.map((r) => ({
        type: r.type,
        count: r._count.id,
      })),
      actionsByType: actionsByType.map((a) => ({
        actionType: a.actionType,
        count: a._count.id,
      })),
      period: { days, startDate, endDate: new Date() },
    });
  } catch (error) {
    console.error("Error fetching moderation stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 },
    );
  }
}
