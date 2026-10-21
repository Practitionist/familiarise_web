/**
 * User Submitted Moderation Reports API
 * Returns paginated moderation reports submitted by the authenticated user.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type {
  ModerationActionType,
  ModerationReportStatus,
} from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { addMonths } from "date-fns";
import { formatReportReference } from "@/lib/moderation/report-reference";

const userReportsQuerySchema = z.object({
  scope: z.enum(["submitted", "decisions"]).default("submitted"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .transform((n) => Math.min(100, Math.max(1, n)))
    .default(20),
});

export type PublicReportOutcome =
  | "PENDING_REVIEW"
  | "NO_ACTION_TAKEN"
  | "CONTENT_REMOVED"
  | "EXCLUDED_FROM_AGGREGATE"
  | "POLICY_ACTION_TAKEN";

function derivePublicReportOutcome(
  status: ModerationReportStatus,
  latestActionType: ModerationActionType | null,
): PublicReportOutcome {
  if (
    status === "PENDING" ||
    status === "UNDER_REVIEW" ||
    status === "ESCALATED"
  ) {
    return "PENDING_REVIEW";
  }
  if (status === "DISMISSED" || latestActionType === "NO_ACTION") {
    return "NO_ACTION_TAKEN";
  }
  if (
    latestActionType === "CONTENT_REMOVED" ||
    latestActionType === "REVIEW_REMOVED" ||
    latestActionType === "REVIEW_REPLY_REMOVED"
  ) {
    return "CONTENT_REMOVED";
  }
  if (
    latestActionType === "REVIEW_EXCLUDED_FROM_AGGREGATE" ||
    latestActionType === "FEEDBACK_EXCLUDED_FROM_AGGREGATE"
  ) {
    return "EXCLUDED_FROM_AGGREGATE";
  }
  return "POLICY_ACTION_TAKEN";
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { searchParams } = new URL(req.url);
    const parsedQuery = userReportsQuerySchema.safeParse({
      scope: searchParams.get("scope") ?? undefined,
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

    const { page, limit, scope } = parsedQuery.data;
    const offset = (page - 1) * limit;
    const where =
      scope === "submitted"
        ? { reportedById: session.user.id }
        : { targetUserId: session.user.id, status: "ACTION_TAKEN" as const };

    if (scope === "decisions") {
      const actorWhere = {
        OR: [
          { report: { targetUserId: session.user.id } },
          { review: { consulteeProfile: { userId: session.user.id } } },
          {
            review: { consultantProfile: { userId: session.user.id } },
            actionType: "REVIEW_REPLY_REMOVED" as const,
          },
          { feedback: { userId: session.user.id } },
        ],
      };
      const [actions, count] = await Promise.all([
        prisma.moderationAction.findMany({
          where: actorWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: offset,
          take: limit,
          select: {
            id: true,
            reportId: true,
            actionType: true,
            createdAt: true,
          },
        }),
        prisma.moderationAction.count({ where: actorWhere }),
      ]);
      return NextResponse.json({
        reports: actions.map((action) => ({
          reportId: action.reportId ?? action.id,
          reference: formatReportReference(action.reportId ?? action.id),
          type: "MODERATION_DECISION",
          status: "ACTION_TAKEN",
          createdAt: action.createdAt,
          resolvedAt: action.createdAt,
          moderationActionId: action.id,
          appealUntil: addMonths(action.createdAt, 6),
          outcome: derivePublicReportOutcome("ACTION_TAKEN", action.actionType),
        })),
        pagination: {
          total: count,
          page,
          limit,
          totalPages: Math.ceil(count / limit),
          hasMore: offset + limit < count,
        },
      });
    }
    const [rows, total] = await Promise.all([
      prisma.moderationReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          type: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
          actions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, createdAt: true, actionType: true },
          },
        },
      }),
      prisma.moderationReport.count({ where }),
    ]);

    const reports = rows.map((row) => ({
      reportId: row.id,
      reference: formatReportReference(row.id),
      type: row.type,
      status: row.status,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      moderationActionId: row.actions[0]?.id ?? null,
      appealUntil: row.actions[0]
        ? addMonths(row.actions[0].createdAt, 6)
        : null,
      outcome: derivePublicReportOutcome(
        row.status,
        row.actions[0]?.actionType ?? null,
      ),
    }));

    return NextResponse.json({
      reports,
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
      { tags: { subsystem: "moderation" } },
    );
    return NextResponse.json(
      { error: "Failed to fetch reports" },
      { status: 500 },
    );
  }
}
