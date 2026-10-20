import type { UserRole } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { recomputeConsultantRating } from "@/lib/reviews";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";

/** Restores reversible moderation effects while retaining the original enforcement action. */
export async function reverseAppealedModeration(
  tx: Tx,
  actionId: string,
  actor: { userId: string; role: UserRole | null },
  rationale: string,
) {
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
  ) {
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
    const restoringReply = action.actionType === "REVIEW_REPLY_REMOVED";
    const restoringRating =
      action.actionType === "REVIEW_EXCLUDED_FROM_AGGREGATE";
    const restored = await tx.consultantReview.updateMany({
      where: {
        id: reviewId,
        updatedAt: review.updatedAt,
        ...(restoringReply
          ? { replyRemovedBy: "MODERATION" }
          : restoringRating
            ? { excludedFromAggregateAt: { not: null } }
            : { removedBy: "MODERATION" }),
      },
      data: restoringReply
        ? { replyDeletedAt: null, replyRemovedBy: null }
        : restoringRating
          ? { excludedFromAggregateAt: null }
          : { deletedAt: null, removedBy: null },
    });
    if (!restored.count)
      return {
        ok: false as const,
        error:
          "The review changed or was independently withdrawn by its author.",
      };
    await tx.moderationAction.create({
      data: {
        actionType: restoringReply
          ? "REVIEW_REPLY_RESTORED"
          : restoringRating
            ? "RATING_REINSTATED"
            : "REVIEW_RESTORED",
        reviewId,
        reportId: action.reportId,
        takenById: actor.userId,
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
  if (
    action.actionType === "FEEDBACK_EXCLUDED_FROM_AGGREGATE" &&
    action.feedbackId
  ) {
    const latest = await tx.moderationAction.findFirst({
      where: {
        feedbackId: action.feedbackId,
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
        id: action.feedbackId,
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
        feedbackId: action.feedbackId,
        takenById: actor.userId,
        notes: rationale,
        sideEffects: { reversedActionId: action.id },
      },
    });
    return { ok: true as const };
  }
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
