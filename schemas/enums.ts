import { z } from "zod";

export const CancellationReasonEnum = z.enum([
  "SCHEDULE_CONFLICT",
  "FOUND_ALTERNATIVE",
  "FINANCIAL_REASONS",
  "PERSONAL_EMERGENCY",
  "NO_LONGER_NEEDED",
  "CONSULTANT_UNAVAILABLE",
  "CONSULTANT_EMERGENCY",
  "PAYMENT_FAILED",
  "EXPIRED",
  "OTHER",
]);

export const ProfileVerificationStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "NEEDS_INFO",
]);

export const SupportTicketStatusEnum = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
]);

export const SupportPriorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const SupportIssueTypeEnum = z.enum([
  "CONSULTANT_NO_SHOW",
  "CONSULTANT_LATE",
  "SESSION_ENDED_EARLY",
  "SESSION_QUALITY_POOR",
  "COMMUNICATION_ISSUE",
  "TECHNICAL_ISSUES",
  "WRONG_CONSULTANT",
  "ACCESS_ISSUE",
  "TIMEZONE_CONFUSION",
  "RESCHEDULING_HELP",
  "PAYMENT_FAILED",
  "CHARGED_TWICE",
  "REFUND_REQUEST",
  "BILLING_QUESTION",
  "DOCUMENT_ISSUE",
  "WANT_TO_CANCEL",
  "CANCELLATION_ISSUE",
  "ACCOUNT_ISSUE",
  "GENERAL_INQUIRY",
  "OTHER",
]);

/**
 * Statuses a CLIENT may request via PATCH /api/trials/[trialId].
 *
 * Deliberately narrower than the Prisma `TrialSessionStatus` enum:
 * AWAITING_PAYMENT is server-set only — the accept handler assigns it and the
 * Razorpay webhook clears it — so accepting it from a request body would let a
 * caller mark their own trial as awaiting payment, or worse, sidestep the pay
 * step. Cancelling one still works, because CANCELLED is listed.
 *
 * This list is hand-maintained rather than z.nativeEnum(TrialSessionStatus)
 * precisely so the omission is a decision instead of drift.
 */
export const TrialSessionStatusEnum = z.enum([
  "PENDING",
  "SCHEDULED",
  "COMPLETED",
  "CONVERTED",
  "CANCELLED",
  "REJECTED",
]);

export const RequestStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
  "SCHEDULED",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);
