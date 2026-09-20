/**
 * The one writer for a staff / admin verification decision. The staff and
 * admin routes carried two copies of the same PATCH and neither guarded the
 * transition: an APPROVED or REJECTED row could be decided again, flipping
 * `isVerified` at will. This CASes the row from an open state, bounds the
 * NEEDS_INFO loop, requires a reason code on every flagged document,
 * recomputes the completion score, and stages the consultant's bell and
 * email in the same transaction. The vendor attempts are the caller's job,
 * after commit. See docs/onboarding/04-verification-lifecycle.md.
 */

import {
  Prisma,
  type ConsultantVerificationStatus,
  type VerificationDocumentIssue,
} from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recomputeProfileCompletion } from "@/lib/profiles/profile-completion";
import {
  notifyVerificationStatusChanged,
  type TriggerResult,
} from "@/lib/novu";
import {
  stageVerificationDecidedEmail,
  type StagedOnboardingEmail,
} from "@/lib/email";
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
      /** The consultant's bell + email, staged in the transaction; attempt after commit. */
      staged: {
        bell: TriggerResult | null;
        email: StagedOnboardingEmail | null;
      };
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

/** The `isVerified` write per decision; NEEDS_INFO leaves it untouched. */
const IS_VERIFIED_FOR_DECISION: Record<
  ReviewDecision,
  { isVerified?: boolean }
> = {
  APPROVED: { isVerified: true },
  REJECTED: { isVerified: false },
  NEEDS_INFO: {},
};

/** Per-document verdicts; a document that is not on this request rolls the decision back. */
async function applyDocumentFeedback(
  tx: Tx,
  verificationId: string,
  feedback: DocumentFeedbackInput[],
): Promise<void> {
  for (const f of feedback) {
    const updated = await tx.profileVerificationDocument.updateMany({
      where: { id: f.documentId, verificationId },
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
}

/**
 * The decision and its notice exist together or not at all: the bell and the
 * email rows are staged inside the decision's transaction and the caller
 * attempts them after commit. `profileStatus` is never UNDER_REVIEW here.
 */
async function stageDecisionNotices(
  tx: Tx,
  args: {
    consultantUserId: string | null;
    consultantProfileId: string;
    verificationId: string;
    profileStatus: ConsultantVerificationStatus;
    reason: string | undefined;
  },
): Promise<{
  bell: TriggerResult | null;
  email: StagedOnboardingEmail | null;
}> {
  if (!args.consultantUserId) return { bell: null, email: null };
  const dashboardUrl = `/dashboard/consultant/${args.consultantProfileId}/settings`;
  // The bell template branches on the decision, so NEEDS_INFO is named
  // rather than mapped to the profile's PENDING_VERIFICATION.
  const bell = await notifyVerificationStatusChanged(
    args.consultantUserId,
    {
      status:
        args.profileStatus === "PENDING_VERIFICATION"
          ? "NEEDS_INFO"
          : args.profileStatus,
      reason: args.reason,
      dashboardUrl,
    },
    { tx },
  );
  const email =
    args.profileStatus === "UNDER_REVIEW"
      ? null
      : await stageVerificationDecidedEmail(
          {
            userId: args.consultantUserId,
            verificationId: args.verificationId,
            status: args.profileStatus,
            reason: args.reason,
            dashboardUrl,
          },
          tx,
        );
  return { bell, email };
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

          await applyDocumentFeedback(
            tx,
            input.verificationId,
            input.documentFeedback ?? [],
          );

          const profileStatus = PROFILE_STATUS_FOR_DECISION[input.status];
          await tx.consultantProfile.update({
            where: { id: verification.consultantProfileId },
            data: {
              verificationStatus: profileStatus,
              ...IS_VERIFIED_FOR_DECISION[input.status],
            },
          });
          await recomputeProfileCompletion(
            tx,
            verification.consultantProfileId,
          );

          const consultantUserId =
            verification.consultantProfile.userId ?? null;
          const staged = await stageDecisionNotices(tx, {
            consultantUserId,
            consultantProfileId: verification.consultantProfileId,
            verificationId: input.verificationId,
            profileStatus,
            reason: input.rejectionReason || input.feedbackDetails || undefined,
          });

          return {
            ok: true as const,
            consultantProfileId: verification.consultantProfileId,
            consultantUserId,
            profileStatus,
            round,
            staged,
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
