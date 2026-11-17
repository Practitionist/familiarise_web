/**
 * The PATCH door of `/api/admin/verification/[id]`: a reason, the decision
 * through `reviewVerificationTx` (which stages the consultant's bell and email)
 * and the audit row on one Serializable transaction, then the public-surface
 * purge and the notice attempts after commit.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { ReviewVerificationSchema } from "@/schemas/verifications";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import { attemptTrigger } from "@/lib/novu";
import { attemptOnboardingEmail } from "@/lib/email";
import { reviewVerificationTx, type ReviewDecision } from "./review";
import { documentDownloadPath, REVIEW_DOCUMENT_SELECT } from "./documents";

/** Replace the stored (possibly expired, signed) fileUrl with the ACL'd download route. */
export function withDownloadUrls<T extends { id: string; fileUrl: string }>(
  documents: T[],
): T[] {
  return documents.map((d) => ({ ...d, fileUrl: documentDownloadPath(d.id) }));
}

const DECISION_MESSAGE: Record<ReviewDecision, string> = {
  APPROVED: "Profile approved and verified",
  REJECTED: "Profile verification rejected",
  NEEDS_INFO: "More information requested",
};

export const reviewVerificationDoor = withOpsAction(
  "users.verify",
  "verification.review",
  ReviewVerificationSchema.shape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const verificationId = params.verificationId ?? "";
      const decided = await reviewVerificationTx(tx, {
        verificationId,
        reviewerId: actor.userId,
        status: body.status,
        reviewNotes: body.reviewNotes,
        rejectionReason: body.rejectionReason,
        feedbackDetails: body.feedbackDetails,
        documentFeedback: body.documentFeedback,
      });
      const verification = await tx.consultantProfileVerification.findUnique({
        where: { id: verificationId },
        include: { documents: { select: REVIEW_DOCUMENT_SELECT } },
      });
      const { bell, email } = decided.staged;
      return {
        target: { kind: "ConsultantProfileVerification", id: verificationId },
        before: { status: decided.previousStatus },
        after: {
          status: body.status,
          profileStatus: decided.profileStatus,
          round: decided.round,
        },
        response: {
          verification: verification
            ? {
                ...verification,
                documents: withDownloadUrls(verification.documents),
              }
            : null,
          round: decided.round,
          message: DECISION_MESSAGE[body.status],
        },
        // VERIFIED puts the consultant on the public surfaces, anything else takes them off.
        afterCommit: async () => {
          purgeExpertSurfaces(decided.consultantProfileId);
          if (bell?.success && bell.staged) await attemptTrigger(bell.staged);
          if (email) await attemptOnboardingEmail(email);
        },
      };
    },
  },
  { serializable: true },
);
