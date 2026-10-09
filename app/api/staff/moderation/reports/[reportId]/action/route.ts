/**
 * Staff Moderation Report Action API
 * Take moderation action on a report — with real side-effects (#693).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  ModerationActionType,
  ModerationReportType,
  Prisma,
  UserRole,
} from "@prisma/client";
import { z } from "zod";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { parseJsonRequest } from "@/lib/api/parse";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import {
  applyTransactionalEffects,
  applyBestEffortEffects,
  persistActionSideEffects,
  reportOutcomeCopy,
  reporterIsNotifiedExpert,
  type ModerationReportRef,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";
import * as Sentry from "@sentry/nextjs";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { goHref } from "@/lib/dashboard/go";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { sendModerationReportOutcomeEmail } from "@/lib/email/senders/people";
import { formatReportReference } from "@/lib/moderation/report-reference";
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * POST /api/staff/moderation/reports/[reportId]/action
 * Take moderation action on a report
 */
const VALID_ACTIONS: ModerationActionType[] = [
  "WARNING_ISSUED",
  "CONTENT_REMOVED",
  "USER_SUSPENDED",
  "USER_BANNED",
  "PROFILE_UNVERIFIED",
  "REVIEW_EXCLUDED_FROM_AGGREGATE",
  "FEEDBACK_EXCLUDED_FROM_AGGREGATE",
  "NO_ACTION",
];

type ModerationActionInput = {
  actionType: ModerationActionType;
  report: ModerationReportRef;
  staffUserId: string;
  notes?: string;
  suspensionDays?: number;
};

// Action payload, validated before auth-gated side-effects. `notes` persists
// on the action row — capped so one pasted log dump cannot bloat it.
const moderationActionPayloadSchema = z.object({
  actionType: z.enum(
    VALID_ACTIONS as [ModerationActionType, ...ModerationActionType[]],
  ),
  notes: z.string().max(5000).optional(),
  suspensionDays: z.number().int().min(1).max(365).optional(),
  feedbackId: z.string().min(1).max(64).optional(),
});

async function validateActionTargetBinding(
  report: {
    type: ModerationReportType;
    targetUserId: string;
    reviewId: string | null;
    review: { appointmentId: string | null } | null;
  },
  actionType: ModerationActionType,
  feedbackId: string | undefined,
): Promise<NextResponse | null> {
  if (
    actionType === "CONTENT_REMOVED" &&
    report.type === "REVIEW" &&
    !report.reviewId
  ) {
    return NextResponse.json(
      { error: "This review report names no review to remove" },
      { status: 409 },
    );
  }
  if (actionType === "REVIEW_EXCLUDED_FROM_AGGREGATE" && !report.reviewId) {
    return NextResponse.json(
      { error: "This report names no review to exclude from aggregate" },
      { status: 409 },
    );
  }
  if (actionType !== "FEEDBACK_EXCLUDED_FROM_AGGREGATE") {
    return null;
  }
  if (report.type !== "REVIEW" || !report.review?.appointmentId) {
    return NextResponse.json(
      {
        error:
          "Feedback exclusion requires a review report bound to an appointment",
      },
      { status: 409 },
    );
  }
  if (!feedbackId) {
    return NextResponse.json(
      {
        error: "A feedbackId is required to exclude feedback from aggregate",
      },
      { status: 409 },
    );
  }
  const feedback = await prisma.appointmentFeedback.findUnique({
    where: { id: feedbackId },
    select: { id: true, userId: true, appointmentId: true },
  });
  if (!feedback) {
    return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
  }
  if (
    feedback.userId !== report.targetUserId ||
    feedback.appointmentId !== report.review.appointmentId
  ) {
    return NextResponse.json(
      {
        error:
          "Feedback does not belong to the reported review's session and author",
      },
      { status: 409 },
    );
  }
  return null;
}

// Account-state side-effects commit atomically with the action row — the report
// can never read ACTION_TAKEN while the target kept access.
function applyModerationTransaction(
  reportId: string,
  actionType: ModerationActionType,
  notes: string | undefined,
  staffUserId: string,
  input: ModerationActionInput,
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const moved = await tx.moderationReport.updateMany({
          where: {
            id: reportId,
            status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] },
          },
          data: {
            status: actionType === "NO_ACTION" ? "DISMISSED" : "ACTION_TAKEN",
            resolvedAt: new Date(),
            resolvedBy: staffUserId,
          },
        });
        if (moved.count === 0) {
          throw Object.assign(
            new Error("This report has already been resolved"),
            { httpStatus: 409 },
          );
        }

        const action = await tx.moderationAction.create({
          data: {
            reportId,
            actionType,
            notes,
            takenById: staffUserId,
            reviewId:
              input.report.type === "REVIEW" ? input.report.reviewId : null,
            feedbackId: input.report.feedbackId ?? null,
          },
          include: {
            takenBy: {
              select: { id: true, name: true, email: true },
            },
          },
        });

        const transactional = await applyTransactionalEffects(tx, {
          ...input,
          actionId: action.id,
        });

        const updatedReport = await tx.moderationReport.findUniqueOrThrow({
          where: { id: reportId },
        });

        return { action, updatedReport, transactional };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 30000,
      },
    ),
  );
}

function moderationActionErrorResponse(error: unknown): NextResponse {
  if (error instanceof Error && "httpStatus" in error) {
    const status =
      typeof (error as { httpStatus?: number }).httpStatus === "number"
        ? (error as { httpStatus: number }).httpStatus
        : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "staff" } },
  );
  console.error("Error taking moderation action:", error);
  return NextResponse.json({ error: "Failed to take action" }, { status: 500 });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { reportId } = await params;
    const { data: body, error: bodyError } = await parseJsonRequest(
      moderationActionPayloadSchema,
      req,
    );
    if (bodyError) return bodyError;
    const { actionType, notes, suspensionDays, feedbackId } = body;

    const parsedRole = z.nativeEnum(UserRole).safeParse(session.user.role);
    const canModerateUsers =
      parsedRole.success &&
      hasBackofficePermission(parsedRole.data, "users.moderate");

    const ACCOUNT_DESTRUCTIVE: ModerationActionType[] = [
      "USER_BANNED",
      "USER_SUSPENDED",
    ];
    if (ACCOUNT_DESTRUCTIVE.includes(actionType) && !canModerateUsers) {
      return NextResponse.json(
        {
          error:
            "Forbidden — banning or suspending an account requires an admin",
        },
        { status: 403 },
      );
    }

    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        type: true,
        status: true,
        reportedById: true,
        targetUserId: true,
        reviewId: true,
        streamMessageId: true,
        review: { select: { appointmentId: true } },
      },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    if (report.status === "ACTION_TAKEN" || report.status === "DISMISSED") {
      return NextResponse.json(
        { error: "This report has already been resolved" },
        { status: 409 },
      );
    }

    if (
      actionType === "CONTENT_REMOVED" &&
      report.type === "REVIEW" &&
      !canModerateUsers
    ) {
      return NextResponse.json(
        { error: "Removing public reviews requires administrator permission" },
        { status: 403 },
      );
    }

    const bindingError = await validateActionTargetBinding(
      report,
      actionType,
      feedbackId,
    );
    if (bindingError) return bindingError;

    const input = {
      actionType,
      report: {
        id: report.id,
        type: report.type,
        reportedById: report.reportedById,
        targetUserId: report.targetUserId,
        reviewId: report.reviewId,
        feedbackId,
        streamMessageId: report.streamMessageId,
      },
      staffUserId: session.user.id,
      notes,
      suspensionDays,
    };

    const { action, updatedReport, transactional } =
      await applyModerationTransaction(
        reportId,
        actionType,
        notes,
        session.user.id,
        input,
      );

    if (transactional.reviewRemovedConsultantProfileId) {
      purgeReviewSurfaces(transactional.reviewRemovedConsultantProfileId);
    }

    let sideEffects: SideEffectSummary = transactional;
    try {
      sideEffects = await applyBestEffortEffects(
        { ...input, actionId: action.id },
        transactional,
      );
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }
    await persistActionSideEffects(action.id, sideEffects);

    if (
      report.reportedById &&
      !reporterIsNotifiedExpert(input, transactional)
    ) {
      await sendModerationReportOutcomeEmail(
        {
          reporterUserId: report.reportedById,
          reportId: report.id,
          reference: formatReportReference(report.id),
          ...reportOutcomeCopy(actionType),
          dashboardUrl: goHref("auto", "feedbacks"),
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    }

    return NextResponse.json({
      action,
      report: updatedReport,
      sideEffects,
      message: `Action '${actionType}' taken successfully`,
    });
  } catch (error) {
    return moderationActionErrorResponse(error);
  }
}
