/**
 * The one writer for a staff / admin verification decision, run on the
 * audited door's Serializable transaction. It CASes the row from an open
 * state, bounds the NEEDS_INFO loop, requires a reason code on every flagged
 * document, recomputes the completion score, and stages the consultant's bell
 * and email in the same transaction. The vendor attempts are the caller's job,
 * after commit. See docs/onboarding/04-verification-lifecycle.md.
 */

import type {
  ConsultantVerificationStatus,
  ProfileVerificationStatus,
  VerificationDocumentIssue,
} from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
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
  | "DOCUMENT_NOT_ON_REQUEST"
  | "NO_DOCUMENTS";

export interface ReviewVerificationDecided {
  consultantProfileId: string;
  consultantUserId: string | null;
  /** The request's status before the decision, for the audit row. */
  previousStatus: ProfileVerificationStatus;
  profileStatus: ConsultantVerificationStatus;
  round: number;
  /** The consultant's bell + email, staged in the transaction; attempt after commit. */
  staged: {
    bell: TriggerResult | null;
    email: StagedOnboardingEmail | null;
  };
}

export const REVIEW_REFUSAL_STATUS: Record<ReviewRefusalCode, number> = {
  NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  ROUND_CAP: 409,
  ISSUE_REQUIRED: 400,
  DOCUMENT_NOT_ON_REQUEST: 400,
  NO_DOCUMENTS: 409,
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

const refuse = (code: ReviewRefusalCode, message: string) =>
  new OpsRefusal(code, message, REVIEW_REFUSAL_STATUS[code]);

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
      throw refuse(
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
  const email = await stageVerificationDecidedEmail(
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

/** Decides one request on the caller's transaction; a refusal throws an `OpsRefusal`. */
export async function reviewVerificationTx(
  tx: Tx,
  input: ReviewVerificationInput,
): Promise<ReviewVerificationDecided> {
  if (findFeedbackWithoutIssue(input.documentFeedback)) {
    throw refuse(
      "ISSUE_REQUIRED",
      "Pick a reason for every document you mark invalid so the applicant knows what to fix",
    );
  }
  const verification = await tx.consultantProfileVerification.findUnique({
    where: { id: input.verificationId },
    select: {
      status: true,
      consultantProfileId: true,
      consultantProfile: { select: { userId: true } },
      _count: { select: { documents: true } },
    },
  });
  if (!verification) throw refuse("NOT_FOUND", "Verification not found");
  // An approval vouches for documents the reviewer read; the modal mirrors this.
  if (input.status === "APPROVED" && verification._count.documents === 0) {
    throw refuse(
      "NO_DOCUMENTS",
      "This request has no documents, so it cannot be approved. Use Request Changes to ask for them.",
    );
  }

  const round = await countAnsweredRounds(tx, verification.consultantProfileId);
  if (input.status === "NEEDS_INFO" && round >= MAX_NEEDS_INFO_ROUNDS) {
    throw refuse(
      "ROUND_CAP",
      `This applicant has already answered ${MAX_NEEDS_INFO_ROUNDS} requests for more information; approve or reject.`,
    );
  }

  // Only an open row can be decided; NEEDS_INFO may be closed with a final
  // decision but not asked again.
  const allowedFrom: ("PENDING" | "NEEDS_INFO")[] =
    input.status === "NEEDS_INFO" ? ["PENDING"] : ["PENDING", "NEEDS_INFO"];
  const decided = await tx.consultantProfileVerification.updateMany({
    where: { id: input.verificationId, status: { in: allowedFrom } },
    data: {
      status: input.status,
      reviewedAt: new Date(),
      reviewedById: input.reviewerId,
      reviewNotes: input.reviewNotes ?? null,
      rejectionReason:
        input.status === "APPROVED" ? null : (input.rejectionReason ?? null),
      feedbackDetails:
        input.status === "APPROVED" ? null : (input.feedbackDetails ?? null),
    },
  });
  if (decided.count === 0) {
    throw refuse(
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
  await recomputeProfileCompletion(tx, verification.consultantProfileId);

  const consultantUserId = verification.consultantProfile.userId ?? null;
  const staged = await stageDecisionNotices(tx, {
    consultantUserId,
    consultantProfileId: verification.consultantProfileId,
    verificationId: input.verificationId,
    profileStatus,
    reason: input.rejectionReason || input.feedbackDetails || undefined,
  });

  return {
    consultantProfileId: verification.consultantProfileId,
    consultantUserId,
    previousStatus: verification.status,
    profileStatus,
    round,
    staged,
  };
}
