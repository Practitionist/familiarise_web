/**
 * The one writer for a staff / admin verification decision. The staff and
 * admin routes carried two copies of the same PATCH and neither guarded the
 * transition: an APPROVED or REJECTED row could be decided again, flipping
 * `isVerified` at will. This CASes the row from an open state, bounds the
 * NEEDS_INFO loop, requires a reason code on every flagged document, and
 * recomputes the completion score. Notifications are the caller's job,
 * after commit. See docs/onboarding/04-verification-lifecycle.md.
 */

import {
  Prisma,
  type ConsultantVerificationStatus,
  type VerificationDocumentIssue,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recomputeProfileCompletion } from "@/lib/profiles/profile-completion";
import { countAnsweredRounds } from "./submit-request";

/** After this many answered NEEDS_INFO rounds the next decision must be final. */
export const MAX_NEEDS_INFO_ROUNDS = 3;

export type ReviewDecision = "APPROVED" | "REJECTED" | "NEEDS_INFO";

export interface DocumentFeedbackInput {
  documentId: string;
  isValid: boolean;
  staffFeedback?: string | null;
  issue?: VerificationDocumentIssue | null;
}

export interface ReviewVerificationInput {
  verificationId: string;
  reviewerId: string;
  status: ReviewDecision;
  reviewNotes?: string | null;
  rejectionReason?: string | null;
  feedbackDetails?: string | null;
  documentFeedback?: DocumentFeedbackInput[];
}

export type ReviewRefusalCode =
  | "NOT_FOUND"
  | "ALREADY_DECIDED"
  | "ROUND_CAP"
  | "ISSUE_REQUIRED"
  | "DOCUMENT_NOT_ON_REQUEST";

export type ReviewVerificationOutcome =
  | {
      ok: true;
      consultantProfileId: string;
      consultantUserId: string | null;
      profileStatus: ConsultantVerificationStatus;
      round: number;
    }
  | { ok: false; code: ReviewRefusalCode; message: string };

export const REVIEW_REFUSAL_STATUS: Record<ReviewRefusalCode, number> = {
  NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  ROUND_CAP: 409,
  ISSUE_REQUIRED: 400,
  DOCUMENT_NOT_ON_REQUEST: 400,
};

/** Request status → profile status. NEEDS_INFO returns the profile to the pre-review default. */
export const PROFILE_STATUS_FOR_DECISION: Record<
  ReviewDecision,
  ConsultantVerificationStatus
> = {
  APPROVED: "VERIFIED",
  REJECTED: "REJECTED",
  NEEDS_INFO: "PENDING_VERIFICATION",
};

class ReviewRefused extends Error {
  constructor(
    readonly code: ReviewRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** Pure: every flagged document must carry a reason code. */
export function findFeedbackWithoutIssue(
  feedback: DocumentFeedbackInput[] | undefined,
): string | null {
  for (const f of feedback ?? []) {
    if (!f.isValid && !f.issue) return f.documentId;
  }
  return null;
}

export async function reviewVerification(
  input: ReviewVerificationInput,
): Promise<ReviewVerificationOutcome> {
  const missingIssue = findFeedbackWithoutIssue(input.documentFeedback);
  if (missingIssue) {
    return {
      ok: false,
      code: "ISSUE_REQUIRED",
      message:
        "Pick a reason for every document you mark invalid so the applicant knows what to fix",
    };
  }
  try {
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const verification =
            await tx.consultantProfileVerification.findUnique({
              where: { id: input.verificationId },
              select: {
                status: true,
                consultantProfileId: true,
                consultantProfile: { select: { userId: true } },
              },
            });
          if (!verification) {
            throw new ReviewRefused("NOT_FOUND", "Verification not found");
          }

          const round = await countAnsweredRounds(
            tx,
            verification.consultantProfileId,
          );
          if (input.status === "NEEDS_INFO" && round >= MAX_NEEDS_INFO_ROUNDS) {
            throw new ReviewRefused(
              "ROUND_CAP",
              `This applicant has already answered ${MAX_NEEDS_INFO_ROUNDS} requests for more information; approve or reject.`,
            );
          }

          // Only an open row can be decided; NEEDS_INFO may be closed with a
          // final decision but not asked again.
          const allowedFrom =
            input.status === "NEEDS_INFO"
              ? ["PENDING"]
              : ["PENDING", "NEEDS_INFO"];
          const decided = await tx.consultantProfileVerification.updateMany({
            where: {
              id: input.verificationId,
              status: { in: allowedFrom as ("PENDING" | "NEEDS_INFO")[] },
            },
            data: {
              status: input.status,
              reviewedAt: new Date(),
              reviewedById: input.reviewerId,
              reviewNotes: input.reviewNotes ?? null,
              rejectionReason:
                input.status === "APPROVED"
                  ? null
                  : (input.rejectionReason ?? null),
              feedbackDetails:
                input.status === "APPROVED"
                  ? null
                  : (input.feedbackDetails ?? null),
            },
          });
          if (decided.count === 0) {
            throw new ReviewRefused(
              "ALREADY_DECIDED",
              `This request is ${verification.status.toLowerCase()} and cannot be decided again`,
            );
          }

          for (const f of input.documentFeedback ?? []) {
            const updated = await tx.profileVerificationDocument.updateMany({
              where: { id: f.documentId, verificationId: input.verificationId },
              data: {
                isValid: f.isValid,
                staffFeedback: f.staffFeedback ?? null,
                issue: f.isValid ? null : (f.issue ?? null),
              },
            });
            if (updated.count === 0) {
              throw new ReviewRefused(
                "DOCUMENT_NOT_ON_REQUEST",
                "A document in the feedback does not belong to this request",
              );
            }
          }

          const profileStatus = PROFILE_STATUS_FOR_DECISION[input.status];
          await tx.consultantProfile.update({
            where: { id: verification.consultantProfileId },
            data: {
              verificationStatus: profileStatus,
              ...(input.status === "APPROVED"
                ? { isVerified: true }
                : input.status === "REJECTED"
                  ? { isVerified: false }
                  : {}),
            },
          });
          await recomputeProfileCompletion(
            tx,
            verification.consultantProfileId,
          );

          return {
            ok: true as const,
            consultantProfileId: verification.consultantProfileId,
            consultantUserId: verification.consultantProfile.userId ?? null,
            profileStatus,
            round,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
  } catch (error) {
    if (error instanceof ReviewRefused) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
