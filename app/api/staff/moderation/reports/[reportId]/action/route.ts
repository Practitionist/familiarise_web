/**
 * Staff Moderation Report Action API: resolve a report with its side effects.
 * A gateway door: the Stream and session steps run after the transaction, so
 * the audit row is written once the action has run, SUCCEEDED or FAILED.
 */

import prisma from "@/lib/prisma";
import {
  ModerationActionType,
  ModerationReportType,
  Prisma,
} from "@prisma/client";
import { z } from "zod";

import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { UserRoleEnum } from "@/schemas/user";
import {
  applyTransactionalEffects,
  applyBestEffortEffects,
  prepareModerationNotices,
  type ModerationNoticeDrafts,
  persistActionSideEffects,
  type ModerationReportRef,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";
import * as Sentry from "@sentry/nextjs";
import {
  purgeExpertSurfaces,
  purgeReviewSurfaces,
} from "@/lib/data/public-cache";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";

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

// `notes` persists on the action row, the door's `reason` when absent; capped so
// one pasted log dump cannot bloat it.
const moderationActionShape = {
  actionType: z.enum(
    VALID_ACTIONS as [ModerationActionType, ...ModerationActionType[]],
  ),
  notes: z.string().max(5000).optional(),
  suspensionDays: z.number().int().min(1).max(365).optional(),
  feedbackId: z.string().min(1).max(64).optional(),
};

async function validateActionTargetBinding(
  report: {
    type: ModerationReportType;
    targetUserId: string;
    reviewId: string | null;
    review: { appointmentId: string | null } | null;
  },
  actionType: ModerationActionType,
  feedbackId: string | undefined,
): Promise<void> {
  const unbound = (message: string) =>
    new OpsRefusal("TARGET_NOT_BOUND", message);
  if (
    actionType === "CONTENT_REMOVED" &&
    report.type === "REVIEW" &&
    !report.reviewId
  ) {
    throw unbound("This review report names no review to remove");
  }
  if (actionType === "REVIEW_EXCLUDED_FROM_AGGREGATE" && !report.reviewId) {
    throw unbound("This report names no review to exclude from aggregate");
  }
  if (actionType !== "FEEDBACK_EXCLUDED_FROM_AGGREGATE") return;
  if (report.type !== "REVIEW" || !report.review?.appointmentId) {
    throw unbound(
      "Feedback exclusion requires a review report bound to an appointment",
    );
  }
  if (!feedbackId) {
    throw unbound(
      "A feedbackId is required to exclude feedback from aggregate",
    );
  }
  const feedback = await prisma.appointmentFeedback.findUnique({
    where: { id: feedbackId },
    select: { id: true, userId: true, appointmentId: true },
  });
  if (!feedback) throw new OpsRefusal("NOT_FOUND", "Feedback not found", 404);
  if (
    feedback.userId !== report.targetUserId ||
    feedback.appointmentId !== report.review.appointmentId
  ) {
    throw unbound(
      "Feedback does not belong to the reported review's session and author",
    );
  }
}

// Account-state side-effects commit atomically with the action row — the report
// can never read ACTION_TAKEN while the target kept access.
function applyModerationTransaction(
  reportId: string,
  actionType: ModerationActionType,
  notes: string | undefined,
  staffUserId: string,
  input: ModerationActionInput,
  drafts: ModerationNoticeDrafts,
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // The audit row's before-state is what this transaction resolves from.
        const before = await tx.moderationReport.findUnique({
          where: { id: reportId },
          select: { status: true },
        });
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
          throw new OpsRefusal(
            "REPORT_RESOLVED",
            "This report has already been resolved",
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

        const transactional = await applyTransactionalEffects(
          tx,
          { ...input, actionId: action.id },
          drafts,
        );

        const updatedReport = await tx.moderationReport.findUniqueOrThrow({
          where: { id: reportId },
        });

        return {
          action,
          updatedReport,
          transactional,
          previousStatus: before?.status ?? null,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 30000,
      },
    ),
  );
}

const ACCOUNT_DESTRUCTIVE = new Set<ModerationActionType>([
  "USER_BANNED",
  "USER_SUSPENDED",
]);

/** POST /api/staff/moderation/reports/[reportId]/action — resolve the report. */
export const POST = withOpsAction(
  "moderation.manage",
  (body) => `moderation.action.${body.actionType}`,
  moderationActionShape,
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "ModerationReport",
      id: params.reportId ?? "",
    }),
    run: async ({ body, actor, params }) => {
      const reportId = params.reportId ?? "";
      const { actionType, suspensionDays, feedbackId } = body;
      const notes = body.notes ?? body.reason;

      const role = UserRoleEnum.safeParse(actor.role);
      const canModerateUsers =
        role.success && hasBackofficePermission(role.data, "users.moderate");
      if (ACCOUNT_DESTRUCTIVE.has(actionType) && !canModerateUsers) {
        throw new OpsRefusal(
          "FORBIDDEN",
          "Forbidden — banning or suspending an account requires an admin",
          403,
        );
      }

      const report = await prisma.moderationReport.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          type: true,
          reason: true,
          status: true,
          reportedById: true,
          targetUserId: true,
          reviewId: true,
          streamMessageId: true,
          review: { select: { appointmentId: true } },
        },
      });
      if (!report) throw new OpsRefusal("NOT_FOUND", "Report not found", 404);
      if (report.status === "ACTION_TAKEN" || report.status === "DISMISSED") {
        throw new OpsRefusal(
          "REPORT_RESOLVED",
          "This report has already been resolved",
        );
      }
      if (
        actionType === "CONTENT_REMOVED" &&
        report.type === "REVIEW" &&
        !canModerateUsers
      ) {
        throw new OpsRefusal(
          "FORBIDDEN",
          "Removing public reviews requires administrator permission",
          403,
        );
      }
      await validateActionTargetBinding(report, actionType, feedbackId);

      const input = {
        actionType,
        report: {
          id: report.id,
          type: report.type,
          reason: report.reason,
          reportedById: report.reportedById,
          targetUserId: report.targetUserId,
          reviewId: report.reviewId,
          feedbackId,
          streamMessageId: report.streamMessageId,
        },
        staffUserId: actor.userId,
        notes,
        suspensionDays,
      };

      // Rendered before the decision's transaction, which only stages them.
      const drafts = await prepareModerationNotices(input);
      const { action, updatedReport, transactional, previousStatus } =
        await applyModerationTransaction(
          reportId,
          actionType,
          notes,
          actor.userId,
          input,
          drafts,
        );

      if (transactional.reviewRemovedConsultantProfileId) {
        purgeReviewSurfaces(transactional.reviewRemovedConsultantProfileId);
      }
      // A rejected expert's cached profile must stop offering trials and requests.
      if (transactional.unverifiedConsultantProfileId) {
        purgeExpertSurfaces(transactional.unverifiedConsultantProfileId);
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
      // Session ends carry IPs and phase 2 has stamped them; never persist
      // them, nor the seat holders phase 2 mails.
      const {
        stagedBells,
        stagedEmails,
        stagedSessionEnds,
        owedCohostEmails,
        unpaidSalesEnded,
        ...persistedSideEffects
      } = sideEffects;
      await persistActionSideEffects(action.id, persistedSideEffects);
      await flushNotificationsAfter(
        { bells: stagedBells, emails: stagedEmails },
        "moderation.action",
      );

      return {
        target: { kind: "ModerationReport", id: reportId },
        // `status` is the gateway door's own SUCCEEDED or FAILED.
        before: { reportStatus: previousStatus ?? report.status },
        after: {
          reportStatus: updatedReport.status,
          actionType,
          actionId: action.id,
        },
        response: {
          action,
          report: updatedReport,
          sideEffects: persistedSideEffects,
          message: `Action '${actionType}' taken successfully`,
        },
      };
    },
  },
);
