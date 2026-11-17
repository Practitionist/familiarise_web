/**
 * Staff Moderation Report Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportStatus, type Prisma } from "@prisma/client";
import { z } from "zod";

import { isPrivileged, requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  readExclusionDropsBelowGate,
  readReviewReportContext,
} from "@/lib/moderation/review-context";
import * as Sentry from "@sentry/nextjs";

import { PatchReportSchema } from "@/schemas/moderation";

const patchReportShape = {
  status: PatchReportSchema.shape.status.optional(),
  assignedToId: z.string().nullable().optional(),
  expectedStatus: z.nativeEnum(ModerationReportStatus),
  expectedAssignedToId: z.string().nullable(),
};
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * GET /api/staff/moderation/reports/[reportId]
 * Get report details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("moderation.manage");
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
        supportCase: { select: { id: true, referenceNumber: true } },
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
  validatedData: z.infer<z.ZodObject<typeof patchReportShape>>,
): Prisma.ModerationReportUpdateManyMutationInput {
  const updateData: Prisma.ModerationReportUpdateManyMutationInput = {};
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
 * Move an open report's status or assignee: an audited door, compare-and-set
 * on the status and assignee the operator saw. Resolving goes through `action`.
 */
export const PATCH = withOpsAction(
  "moderation.manage",
  "moderation.report.update",
  patchReportShape,
  {
    mode: "tx",
    run: async (tx, { body, params }) => {
      const reportId = params.reportId ?? "";
      if (body.assignedToId) {
        const assignee = await tx.user.findUnique({
          where: { id: body.assignedToId },
          select: { role: true },
        });
        if (!isPrivileged(assignee?.role)) {
          throw new OpsRefusal(
            "INVALID_ASSIGNEE",
            "Assignee must be a staff or admin user",
            400,
          );
        }
      }
      const existing = await tx.moderationReport.findUnique({
        where: { id: reportId },
        select: { status: true, assignedToId: true },
      });
      if (!existing) {
        throw new OpsRefusal("NOT_FOUND", "Report not found", 404);
      }
      if (
        existing.status === "DISMISSED" ||
        existing.status === "ACTION_TAKEN"
      ) {
        throw new OpsRefusal(
          "REPORT_RESOLVED",
          "This report is already resolved",
        );
      }
      const updated = await tx.moderationReport.updateMany({
        where: {
          id: reportId,
          assignedToId: body.expectedAssignedToId,
          AND: [
            { status: body.expectedStatus },
            { status: { notIn: ["DISMISSED", "ACTION_TAKEN"] } },
          ],
        },
        data: buildReportPatchData(body),
      });
      if (updated.count === 0) {
        throw new OpsRefusal(
          "REPORT_CHANGED",
          "Report was modified concurrently",
        );
      }
      const report = await tx.moderationReport.findUnique({
        where: { id: reportId },
        include: {
          reportedBy: { select: { id: true, name: true, email: true } },
          targetUser: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
      });
      return {
        target: { kind: "ModerationReport", id: reportId },
        before: {
          status: existing.status,
          assignedToId: existing.assignedToId,
        },
        after: {
          status: report?.status ?? existing.status,
          assignedToId: report?.assignedToId ?? null,
        },
        response: { report },
      };
    },
  },
);
