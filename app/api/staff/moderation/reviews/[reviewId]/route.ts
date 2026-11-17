/**
 * DELETE /api/staff/moderation/reviews/[reviewId] — take a public review down.
 *
 * An audited door on `users.moderate` (ADMIN): a reason, then a soft removal
 * compare-and-set in the WHERE, the moderation row, the rating recompute and
 * the audit row on one Serializable transaction. A takedown also lands on an
 * author-withdrawn row (moderation wins; the author could otherwise revive
 * it); a row moderation already removed answers 409.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { recomputeConsultantRating } from "@/lib/reviews";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";

export const DELETE = withOpsAction(
  "users.moderate",
  "moderation.review.remove",
  {},
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const reviewId = params.reviewId ?? "";
      const review = await tx.consultantReview.findUnique({
        where: { id: reviewId },
        select: { consultantProfileId: true, deletedAt: true, removedBy: true },
      });
      if (!review) throw new OpsRefusal("NOT_FOUND", "Review not found", 404);

      const removed = await tx.consultantReview.updateMany({
        where: {
          id: reviewId,
          OR: [{ deletedAt: null }, { removedBy: "AUTHOR" }],
        },
        data: { deletedAt: new Date(), removedBy: "MODERATION" },
      });
      if (removed.count === 0) {
        throw new OpsRefusal(
          "REVIEW_ALREADY_REMOVED",
          "This review was already removed",
        );
      }
      await tx.moderationAction.create({
        data: {
          actionType: "REVIEW_REMOVED",
          reviewId,
          takenById: actor.userId,
          notes: body.reason,
        },
      });
      await recomputeConsultantRating(tx, review.consultantProfileId);
      return {
        target: { kind: "ConsultantReview", id: reviewId },
        before: {
          deletedAt: review.deletedAt?.toISOString() ?? null,
          removedBy: review.removedBy,
        },
        after: { removedBy: "MODERATION" },
        response: {
          success: true,
          message: "Review removed and consultant rating recalculated",
        },
        afterCommit: () => purgeReviewSurfaces(review.consultantProfileId),
      };
    },
  },
  { serializable: true },
);
