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
import { getSession } from "@/lib/auth-server";
import { formatReportReference } from "@/lib/moderation/report-reference";

const userReportsQuerySchema = z.object({
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
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const parsedQuery = userReportsQuerySchema.safeParse({
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

    const { page, limit } = parsedQuery.data;
    const offset = (page - 1) * limit;
    const where = { reportedById: session.user.id };

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
            select: { actionType: true },
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
