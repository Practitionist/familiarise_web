/**
 * Staff Moderation Report Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportStatus } from "@prisma/client";
import { z } from "zod";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import {
  readExclusionDropsBelowGate,
  readReviewReportContext,
} from "@/lib/moderation/review-context";
import * as Sentry from "@sentry/nextjs";

import { PatchReportSchema } from "@/schemas/moderation";

const patchReportSchema = z.object({
  status: PatchReportSchema.shape.status.optional(),
  assignedToId: z.string().nullable().optional(),
  expectedStatus: z.enum([
    "PENDING",
    "UNDER_REVIEW",
    "DISMISSED",
    "ACTION_TAKEN",
    "ESCALATED",
  ] as const satisfies readonly ModerationReportStatus[]),
  expectedAssignedToId: z.string().nullable(),
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
            appointmentId: true,
            consultantProfile: {
              select: { user: { select: { name: true } } },
            },
          },
        },
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

    const [bookingContext, exclusionDropsBelowGate] = await Promise.all([
      report.review?.appointmentId
        ? readReviewReportContext(report.review.appointmentId)
        : null,
      report.review ? readExclusionDropsBelowGate(report.review.id) : false,
    ]);

    return NextResponse.json({
      report: {
        ...report,
        bookingContext,
        exclusionDropsBelowGate,
      },
    });
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

function buildReportPatchData(
  validatedData: z.infer<typeof patchReportSchema>,
): {
  status?: ModerationReportStatus;
  assignedToId?: string | null;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
} {
  const updateData: {
    status?: ModerationReportStatus;
    assignedToId?: string | null;
    resolvedAt?: Date | null;
    resolvedBy?: string | null;
  } = {};

  if (validatedData.status !== undefined) {
    updateData.status = validatedData.status;
    updateData.resolvedAt = null;
    updateData.resolvedBy = null;
  }

  if (validatedData.assignedToId !== undefined) {
    updateData.assignedToId = validatedData.assignedToId || null;
  }

  return updateData;
}

/**
 * PATCH /api/staff/moderation/reports/[reportId]
 * Update report status or assignment
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { reportId } = await params;
    const rawBody = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== "object") {
      return NextResponse.json(
        { error: "Invalid request body", details: [] },
        { status: 400 },
      );
    }
    const parsed = patchReportSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const { assignedToId } = parsed.data;

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
      select: { id: true, status: true, assignedToId: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    if (existing.status === "DISMISSED" || existing.status === "ACTION_TAKEN") {
      return NextResponse.json(
        { error: "This report is already resolved" },
        { status: 409 },
      );
    }

    const updateData = buildReportPatchData(parsed.data);
    // Resolved reports change only through the audited action route.
    const updated = await prisma.moderationReport.updateMany({
      where: {
        id: reportId,
        assignedToId: parsed.data.expectedAssignedToId,
        AND: [
          { status: parsed.data.expectedStatus },
          { status: { notIn: ["DISMISSED", "ACTION_TAKEN"] } },
        ],
      },
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
