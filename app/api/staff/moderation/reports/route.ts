/**
 * Staff Moderation Reports API
 * List and create moderation reports
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { readReviewReportSignals } from "@/lib/moderation/review-context";
import {
  ModerationReportType,
  ModerationReportStatus,
  Prisma,
  UserRole,
} from "@prisma/client";
import { z } from "zod";

const moderationReportsQuerySchema = z.object({
  type: z
    .enum([
      "REVIEW",
      "PROFILE",
      "MESSAGE",
      "DOCUMENT",
      "OTHER",
    ] as const satisfies readonly ModerationReportType[])
    .optional(),
  status: z
    .enum([
      "PENDING",
      "UNDER_REVIEW",
      "DISMISSED",
      "ACTION_TAKEN",
      "ESCALATED",
    ] as const satisfies readonly ModerationReportStatus[])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .transform((n) => Math.min(100, Math.max(1, n)))
    .default(20),
});

const REPORT_INCLUDE = {
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
  actions: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      id: true,
      actionType: true,
      createdAt: true,
      sideEffects: true,
      notes: true,
      takenBy: { select: { name: true } },
    },
  },
  _count: {
    select: { actions: true },
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
} satisfies Prisma.ModerationReportInclude;

const REPORT_ORDER_BY: Prisma.ModerationReportOrderByWithRelationInput[] = [
  { status: "asc" },
  { reportCount: "desc" },
  { createdAt: "desc" },
];

/**
 * GET /api/staff/moderation/reports
 * List moderation reports with filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const parsedQuery = moderationReportsQuerySchema.safeParse({
      type: searchParams.get("type") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          error: "Invalid query parameters",
          details: parsedQuery.error.issues,
        },
        { status: 400 },
      );
    }
    const { type, status, page, limit } = parsedQuery.data;
    const assignedToId = searchParams.get("assignedToId");
    const organizationId = searchParams.get("organizationId");
    const search = searchParams.get("search");
    const offset = (page - 1) * limit;

    const filterWhere: Prisma.ModerationReportWhereInput = {};

    if (type) filterWhere.type = type;
    if (assignedToId) {
      filterWhere.assignedToId =
        assignedToId === "unassigned" ? null : assignedToId;
    }
    if (organizationId) {
      filterWhere.organizationId =
        organizationId === "personal" ? null : organizationId;
    }
    if (search) {
      filterWhere.OR = [
        { id: { contains: search, mode: "insensitive" } },
        { reason: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { contentText: { contains: search, mode: "insensitive" } },
        { reportedBy: { name: { contains: search, mode: "insensitive" } } },
        { targetUser: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const where: Prisma.ModerationReportWhereInput = status
      ? { ...filterWhere, status }
      : filterWhere;

    const coercionWhere: Prisma.ModerationReportWhereInput = {
      ...where,
      reason: "COERCION_OR_RETALIATION",
    };
    const nonCoercionWhere: Prisma.ModerationReportWhereInput = {
      ...where,
      reason: { not: "COERCION_OR_RETALIATION" },
    };

    const [total, coercionCount, statusCounts] = await Promise.all([
      prisma.moderationReport.count({ where }),
      prisma.moderationReport.count({ where: coercionWhere }),
      prisma.moderationReport.groupBy({
        by: ["status"],
        where: filterWhere,
        _count: { id: true },
      }),
    ]);

    const coercionSkip = offset < coercionCount ? offset : 0;
    const coercionTake =
      offset < coercionCount ? Math.min(limit, coercionCount - offset) : 0;
    const nonCoercionSkip = Math.max(0, offset - coercionCount);
    const nonCoercionTake = limit - coercionTake;

    const [coercionReports, nonCoercionReports] = await Promise.all([
      coercionTake > 0
        ? prisma.moderationReport.findMany({
            where: coercionWhere,
            include: REPORT_INCLUDE,
            orderBy: REPORT_ORDER_BY,
            skip: coercionSkip,
            take: coercionTake,
          })
        : Promise.resolve([]),
      nonCoercionTake > 0
        ? prisma.moderationReport.findMany({
            where: nonCoercionWhere,
            include: REPORT_INCLUDE,
            orderBy: REPORT_ORDER_BY,
            skip: nonCoercionSkip,
            take: nonCoercionTake,
          })
        : Promise.resolve([]),
    ]);

    const reports = [...coercionReports, ...nonCoercionReports];

    const appointmentIds = reports
      .map((r) => r.review?.appointmentId)
      .filter((id): id is string => Boolean(id));
    const signalsByAppointment = await readReviewReportSignals(appointmentIds);

    const formattedReports = reports.map((report) => ({
      id: report.id,
      type: report.type,
      status: report.status,
      reason: report.reason,
      description: report.description,
      contentText: report.contentText,
      contentUrl: report.contentUrl,
      streamMessageId: report.streamMessageId,
      streamChannelCid: report.streamChannelCid,
      reportCount: report.reportCount,
      reportedBy: report.reportedBy,
      targetUser: report.targetUser,
      reviewId: report.reviewId,
      review: report.review,
      contextSignals: report.review?.appointmentId
        ? (signalsByAppointment[report.review.appointmentId] ?? null)
        : null,
      organizationId: report.organizationId ?? null,
      assignedToId: report.assignedToId,
      actionCount: report._count.actions,
      latestAction: report.actions[0] ?? null,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
    }));

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

    const parsedRole = z.nativeEnum(UserRole).safeParse(auth.session.user.role);

    return NextResponse.json({
      reports: formattedReports,
      counts,
      capabilities: {
        canModerateUsers:
          parsedRole.success &&
          hasBackofficePermission(parsedRole.data, "users.moderate"),
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching moderation reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch moderation reports" },
      { status: 500 },
    );
  }
}
