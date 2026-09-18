/**
 * The PATCH body both review routes share (`/api/staff/moderation/profiles/[id]`
 * and `/api/admin/verification/[id]`): validate, decide through
 * `reviewVerification`, purge the public surfaces, stage the consultant's bell
 * and email before the response and attempt them in `after()`.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ReviewVerificationSchema } from "@/schemas/verifications";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import { attemptTrigger, notifyVerificationStatusChanged } from "@/lib/novu";
import {
  attemptOnboardingEmail,
  stageVerificationDecidedEmail,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { reviewVerification, REVIEW_REFUSAL_STATUS } from "./review";
import { documentDownloadPath } from "./documents";

/** Replace the stored (possibly expired, signed) fileUrl with the ACL'd download route. */
export function withDownloadUrls<T extends { id: string; fileUrl: string }>(
  documents: T[],
): T[] {
  return documents.map((d) => ({ ...d, fileUrl: documentDownloadPath(d.id) }));
}

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

  if (outcome.consultantUserId) {
    const payload = {
      status: outcome.profileStatus,
      reason: rejectionReason || feedbackDetails || undefined,
      dashboardUrl: `/dashboard/consultant/${outcome.consultantProfileId}/settings`,
    };
    const bell = await notifyVerificationStatusChanged(
      outcome.consultantUserId,
      payload,
      { tx: prisma },
    ).catch((err) => {
      console.error("[verification-decided-bell] stage failed:", err);
      return null;
    });
    // A decision never yields UNDER_REVIEW; the email type excludes it.
    const emailStatus =
      outcome.profileStatus === "UNDER_REVIEW"
        ? "PENDING_VERIFICATION"
        : outcome.profileStatus;
    const stagedEmail = await stageVerificationDecidedEmail({
      userId: outcome.consultantUserId,
      verificationId,
      status: emailStatus,
      reason: payload.reason,
      dashboardUrl: payload.dashboardUrl,
    });
    scheduleAfter(async () => {
      if (bell?.success && bell.staged) await attemptTrigger(bell.staged);
      await attemptOnboardingEmail(stagedEmail);
    });
  }

  const verification = await prisma.consultantProfileVerification.findUnique({
    where: { id: verificationId },
    include: { documents: true },
  });
  return NextResponse.json({
    verification: verification
      ? { ...verification, documents: withDownloadUrls(verification.documents) }
      : null,
    round: outcome.round,
    message:
      status === "APPROVED"
        ? "Profile approved and verified"
        : status === "REJECTED"
          ? "Profile verification rejected"
          : "More information requested",
  });
}
