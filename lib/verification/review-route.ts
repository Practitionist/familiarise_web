/**
 * The PATCH body both review routes share (`/api/staff/moderation/profiles/[id]`
 * and `/api/admin/verification/[id]`): validate, decide through
 * `reviewVerification` (which stages the consultant's bell and email in its
 * transaction), purge the public surfaces, and attempt the notices in `after()`.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ReviewVerificationSchema } from "@/schemas/verifications";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import { attemptTrigger } from "@/lib/novu";
import { attemptOnboardingEmail } from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  reviewVerification,
  REVIEW_REFUSAL_STATUS,
  type ReviewDecision,
} from "./review";
import { documentDownloadPath } from "./documents";

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

export async function handleReviewPatch(
  body: unknown,
  verificationId: string,
  reviewerId: string,
): Promise<NextResponse> {
  const parsed = ReviewVerificationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const {
    status,
    reviewNotes,
    rejectionReason,
    feedbackDetails,
    documentFeedback,
  } = parsed.data;

  const outcome = await reviewVerification({
    verificationId,
    reviewerId,
    status,
    reviewNotes,
    rejectionReason,
    feedbackDetails,
    documentFeedback,
  });
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.message, code: outcome.code },
      { status: REVIEW_REFUSAL_STATUS[outcome.code] },
    );
  }

  // VERIFIED puts the consultant on the public surfaces, anything else takes
  // them off. Purge now rather than leave the ISR window to expire.
  purgeExpertSurfaces(outcome.consultantProfileId);

  // The notice rows were staged inside the decision's transaction; only
  // the vendor attempts run after the response.
  const { bell, email } = outcome.staged;
  scheduleAfter(async () => {
    if (bell?.success && bell.staged) await attemptTrigger(bell.staged);
    if (email) await attemptOnboardingEmail(email);
  });

  const verification = await prisma.consultantProfileVerification.findUnique({
    where: { id: verificationId },
    include: { documents: true },
  });
  return NextResponse.json({
    verification: verification
      ? { ...verification, documents: withDownloadUrls(verification.documents) }
      : null,
    round: outcome.round,
    message: DECISION_MESSAGE[status],
  });
}
