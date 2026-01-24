/**
 * Staff Moderation Reports API
 * List and create moderation reports
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  UserRole,
  ModerationReportType,
  ModerationReportStatus,
  Prisma,
} from "@prisma/client";

/**
 * GET /api/staff/moderation/reports
 * List moderation reports with filters
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
    const type = searchParams.get("type") as ModerationReportType | null;
    const status = searchParams.get("status") as ModerationReportStatus | null;
    const assignedToId = searchParams.get("assignedToId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    const where: Prisma.ModerationReportWhereInput = {};

    if (type) where.type = type;
    if (status) where.status = status;
    if (assignedToId) {
      where.assignedToId = assignedToId === "unassigned" ? null : assignedToId;
    }

    const [reports, total] = await Promise.all([
      prisma.moderationReport.findMany({
        where,
        include: {
          reportedBy: {
            select: { id: true, name: true, email: true, image: true },
          },
          targetUser: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              role: true,
            },
          },
          _count: {
            select: { actions: true },
          },
        },
        orderBy: [
          { status: "asc" }, // Pending first
          { reportCount: "desc" }, // More reports = higher priority
          { createdAt: "desc" },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.moderationReport.count({ where }),
    ]);

    const formattedReports = reports.map((report) => ({
      id: report.id,
      type: report.type,
      status: report.status,
      reason: report.reason,
      description: report.description,
      contentText: report.contentText,
      contentUrl: report.contentUrl,
      reportCount: report.reportCount,
      reportedBy: report.reportedBy,
      targetUser: report.targetUser,
      reviewId: report.reviewId,
      assignedToId: report.assignedToId,
      actionCount: report._count.actions,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
    }));

    // Get counts by status
    const statusCounts = await prisma.moderationReport.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    const counts = {
      total,
      pending: statusCounts.find((s) => s.status === "PENDING")?._count.id || 0,
      underReview:
        statusCounts.find((s) => s.status === "UNDER_REVIEW")?._count.id || 0,
      dismissed:
        statusCounts.find((s) => s.status === "DISMISSED")?._count.id || 0,
      actionTaken:
        statusCounts.find((s) => s.status === "ACTION_TAKEN")?._count.id || 0,
      escalated:
        statusCounts.find((s) => s.status === "ESCALATED")?._count.id || 0,
    };

    return NextResponse.json({
      reports: formattedReports,
      counts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching moderation reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch moderation reports" },
      { status: 500 },
    );
  }
}
