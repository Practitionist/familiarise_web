import type {
  ModerationAction,
  ModerationActionType,
  Prisma,
  UserRole,
} from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { recomputeConsultantRating } from "@/lib/reviews";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";

/** A restored review names its consultant so the caller can purge public review caches. */
type ReversalResult =
  { ok: false; error: string } | { ok: true; consultantProfileId?: string };

function reviewRestoration(actionType: ModerationActionType): {
  where: Prisma.ConsultantReviewWhereInput;
  data: Prisma.ConsultantReviewUpdateManyMutationInput;
  actionType: ModerationActionType;
} {
  if (actionType === "REVIEW_REPLY_REMOVED")
    return {
      where: { replyRemovedBy: "MODERATION" },
      data: { replyDeletedAt: null, replyRemovedBy: null },
      actionType: "REVIEW_REPLY_RESTORED",
    };
  if (actionType === "REVIEW_EXCLUDED_FROM_AGGREGATE")
    return {
      where: { excludedFromAggregateAt: { not: null } },
      data: { excludedFromAggregateAt: null },
      actionType: "RATING_REINSTATED",
    };
  return {
    where: { removedBy: "MODERATION" },
    data: { deletedAt: null, removedBy: null },
    actionType: "REVIEW_RESTORED",
  };
}

async function restoreReview(
  tx: Tx,
  action: ModerationAction,
  reviewId: string,
  actorId: string,
  rationale: string,
): Promise<ReversalResult> {
  const review = await tx.consultantReview.findUniqueOrThrow({
    where: { id: reviewId },
  });
  const latest = await tx.moderationAction.findFirst({
    where: {
      OR: [{ reviewId }, { report: { reviewId } }],
      actionType: {
        in: [
          "CONTENT_REMOVED",
          "REVIEW_REMOVED",
          "REVIEW_REPLY_REMOVED",
          "REVIEW_EXCLUDED_FROM_AGGREGATE",
          "REVIEW_RESTORED",
          "REVIEW_REPLY_RESTORED",
          "RATING_REINSTATED",
        ],
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== action.id)
    return {
      ok: false as const,
      error:
        "A newer moderation decision exists. Review that decision before restoring content.",
    };
  const restoration = reviewRestoration(action.actionType);
  const restored = await tx.consultantReview.updateMany({
    where: {
      id: reviewId,
      updatedAt: review.updatedAt,
      ...restoration.where,
    },
    data: restoration.data,
  });
  if (!restored.count)
    return {
      ok: false as const,
      error: "The review changed or was independently withdrawn by its author.",
    };
  await tx.moderationAction.create({
    data: {
      actionType: restoration.actionType,
      reviewId,
      reportId: action.reportId,
      takenById: actorId,
      notes: rationale,
      sideEffects: { reversedActionId: action.id },
    },
  });
  await recomputeConsultantRating(tx, review.consultantProfileId);
  return {
    ok: true as const,
    consultantProfileId: review.consultantProfileId,
  };
}

async function restoreRating(
  tx: Tx,
  action: ModerationAction,
  feedbackId: string,
  actorId: string,
  rationale: string,
): Promise<ReversalResult> {
  const latest = await tx.moderationAction.findFirst({
    where: {
      feedbackId,
      actionType: {
        in: ["FEEDBACK_EXCLUDED_FROM_AGGREGATE", "RATING_REINSTATED"],
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== action.id)
    return {
      ok: false as const,
      error:
        "A newer moderation decision exists. Review that decision before restoring content.",
    };
  const restored = await tx.appointmentFeedback.updateMany({
    where: {
      id: feedbackId,
      excludedFromAggregateAt: { not: null },
      deletedAt: null,
    },
    data: { excludedFromAggregateAt: null },
  });
  if (!restored.count)
    return {
      ok: false as const,
      error: "The rating changed or was removed.",
    };
  await tx.moderationAction.create({
    data: {
      actionType: "RATING_REINSTATED",
      feedbackId,
      takenById: actorId,
      notes: rationale,
      sideEffects: { reversedActionId: action.id },
    },
  });
  return { ok: true as const };
}

/** Restores reversible moderation effects while retaining the original enforcement action. */
export async function reverseAppealedModeration(
  tx: Tx,
  actionId: string,
  actor: { userId: string; role: UserRole | null },
  rationale: string,
): Promise<ReversalResult> {
  if (!hasBackofficePermission(actor.role, "users.moderate"))
    return {
      ok: false as const,
      error: "An administrator must execute a moderation reversal.",
    };
  const action = await tx.moderationAction.findUniqueOrThrow({
    where: { id: actionId },
    include: { report: true },
  });
  const reviewId = action.reviewId ?? action.report?.reviewId;
  if (
    reviewId &&
    [
      "CONTENT_REMOVED",
      "REVIEW_REMOVED",
      "REVIEW_REPLY_REMOVED",
      "REVIEW_EXCLUDED_FROM_AGGREGATE",
    ].includes(action.actionType)
  )
    return restoreReview(tx, action, reviewId, actor.userId, rationale);
  if (
    action.actionType === "FEEDBACK_EXCLUDED_FROM_AGGREGATE" &&
    action.feedbackId
  )
    return restoreRating(
      tx,
      action,
      action.feedbackId,
      actor.userId,
      rationale,
    );
  if (action.reportId) {
    const compensating = await tx.moderationAction.findFirst({
      where: {
        reportId: action.reportId,
        createdAt: { gt: action.createdAt },
        actionType: "USER_REINSTATED",
      },
      select: { id: true },
    });
    if (compensating) return { ok: true as const };
  }
  return {
    ok: false as const,
    error:
      "Complete the audited enforcement reversal in the moderation workspace first. Removed external content may require a replacement upload.",
  };
}
