/**
 * The bodies the people screens send to their audited doors. One builder per
 * door, so a contract test can post exactly what a control sends. Pure.
 */

import type { ModerationActionType } from "@prisma/client";

/** A moderation action: the reason is the audit row's and, with any note, the action's. */
export function moderationActionBody(input: {
  actionType: ModerationActionType;
  reason: string;
  note?: string;
  suspensionDays?: number;
}) {
  const notes = [input.reason, input.note?.trim()].filter(Boolean).join("\n\n");
  return {
    actionType: input.actionType,
    notes,
    reason: input.reason,
    ...(input.actionType === "USER_SUSPENDED" && input.suspensionDays
      ? { suspensionDays: input.suspensionDays }
      : {}),
  };
}

/** Lifting a ban; the note is kept on the moderation row when given. */
export function unbanBody(input: { reason: string; note?: string }) {
  const note = input.note?.trim();
  return { reason: input.reason, ...(note ? { notes: note } : {}) };
}

/** A verification decision: the applicant reads the reason and feedback; the audit row keeps `reason`. */
export function verificationReviewBody(input: {
  status: "APPROVED" | "REJECTED" | "NEEDS_INFO";
  reason: string;
  applicantReason?: string;
  feedbackDetails?: string;
  documentFeedback?: {
    documentId: string;
    isValid: boolean;
    staffFeedback?: string;
    issue?: string;
  }[];
}) {
  const asks = input.status !== "APPROVED";
  return {
    status: input.status,
    reason: input.reason,
    ...(asks && input.applicantReason?.trim()
      ? { rejectionReason: input.applicantReason.trim() }
      : {}),
    ...(asks && input.feedbackDetails?.trim()
      ? { feedbackDetails: input.feedbackDetails.trim() }
      : {}),
    ...(input.documentFeedback?.length
      ? { documentFeedback: input.documentFeedback }
      : {}),
  };
}

/** Taking a public review down. */
export const reviewRemovalBody = (reason: string) => ({ reason });

/** A newsletter send: a test goes to the sender, a warm-up to the most recent N. */
export function broadcastSendBody(input: {
  mode: "test" | "warmup" | "all";
  subject: string;
  htmlBody: string;
  reason: string;
  audience: Record<string, unknown>;
  warmupLimit: number;
}) {
  return {
    mode: input.mode,
    subject: input.subject,
    htmlBody: input.htmlBody,
    reason: input.reason,
    ...(input.mode === "test" ? {} : { audience: input.audience }),
    ...(input.mode === "warmup" ? { limit: input.warmupLimit } : {}),
  };
}
