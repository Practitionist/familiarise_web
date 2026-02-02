/**
 * Staff Moderation Report Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole, ModerationReportStatus } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * GET /api/staff/moderation/reports/[reportId]
 * Get report details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
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

    const { reportId } = await params;

    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
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
        actions: {
          include: {
            takenBy: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    return NextResponse.json({ report });
  } catch (error) {
    console.error("Error fetching moderation report:", error);
    return NextResponse.json(
      { error: "Failed to fetch report" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/staff/moderation/reports/[reportId]
 * Update report status or assignment
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
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

    const { reportId } = await params;
    const body = await req.json();
    const { status, assignedToId } = body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};

    if (status !== undefined) {
      const validStatuses: ModerationReportStatus[] = [
        "PENDING",
        "UNDER_REVIEW",
        "DISMISSED",
        "ACTION_TAKEN",
        "ESCALATED",
      ];
      if (!validStatuses.includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      updateData.status = status;

      // Set resolved info if resolving
      if (status === "DISMISSED" || status === "ACTION_TAKEN") {
        updateData.resolvedAt = new Date();
        updateData.resolvedBy = session.user.id;
      }
    }

    if (assignedToId !== undefined) {
      updateData.assignedToId = assignedToId || null;
    }

    const report = await prisma.moderationReport.update({
      where: { id: reportId },
      data: updateData,
      include: {
        reportedBy: {
          select: { id: true, name: true, email: true },
        },
        targetUser: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    return NextResponse.json({ report });
  } catch (error) {
    console.error("Error updating moderation report:", error);
    return NextResponse.json(
      { error: "Failed to update report" },
      { status: 500 },
    );
  }
}
