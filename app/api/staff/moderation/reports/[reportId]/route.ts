/**
 * Staff Moderation Report Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportStatus } from "@prisma/client";
import { z } from "zod";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";

const patchReportSchema = z.object({
  status: z
    .enum([
      "PENDING",
      "UNDER_REVIEW",
      "DISMISSED",
      "ACTION_TAKEN",
      "ESCALATED",
    ] as const satisfies readonly ModerationReportStatus[])
    .optional(),
  assignedToId: z.string().nullable().optional(),
});
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * GET /api/staff/moderation/reports/[reportId]
 * Get report details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { reportId } = await params;

    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      include: {
        reportedBy: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
          },
        },
        targetUser: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
            banned: true,
            banExpires: true,
          },
        },
        review: {
          select: {
            id: true,
            rating: true,
            reviewDescription: true,
            consultantProfile: {
              select: { user: { select: { name: true } } },
            },
          },
        },
        // #1300 — the drawer's audit trail reads top-to-bottom as a history,
        // so it is oldest first; the card's single "last action" line still
        // reads the list route's own `desc`-ordered `actions[0]`.
        actions: {
          include: {
            takenBy: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    return NextResponse.json({ report });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
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
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { reportId } = await params;
    const parsed = patchReportSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    const { status, assignedToId } = parsed.data;

    if (assignedToId) {
      const assignee = await prisma.user.findUnique({
        where: { id: assignedToId },
        select: { id: true, role: true },
      });
      if (
        !assignee ||
        (assignee.role !== "STAFF" && assignee.role !== "ADMIN")
      ) {
        return NextResponse.json(
          { error: "Assignee must be a staff or admin user" },
          { status: 400 },
        );
      }
    }

    const existing = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      select: { id: true, status: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    const updateData: {
      status?: ModerationReportStatus;
      assignedToId?: string | null;
      resolvedAt?: Date | null;
      resolvedBy?: string | null;
    } = {};

    if (status !== undefined) {
      updateData.status = status;

      if (status === "DISMISSED" || status === "ACTION_TAKEN") {
        updateData.resolvedAt = new Date();
        updateData.resolvedBy = session.user.id;
      } else if (status === "PENDING" || status === "UNDER_REVIEW") {
        updateData.resolvedAt = null;
        updateData.resolvedBy = null;
      }
    }

    if (assignedToId !== undefined) {
      updateData.assignedToId = assignedToId || null;
    }

    const updated = await prisma.moderationReport.updateMany({
      where: { id: reportId, status: existing.status },
      data: updateData,
    });
    if (updated.count === 0) {
      return NextResponse.json(
        { error: "Report was modified concurrently" },
        { status: 409 },
      );
    }

    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error updating moderation report:", error);
    return NextResponse.json(
      { error: "Failed to update report" },
      { status: 500 },
    );
  }
}
