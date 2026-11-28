import { z } from "zod";
import type { SupportThreadCategory, SupportCaseStatus } from "@prisma/client";

/**
 * Support-thread intents and statuses — ONE definition, previously transcribed
 * into three separate route files where every copy had lost DOCUMENTS. Since
 * `documentsFlow` (lib/support/flows.ts) carries no `available` gate, the GET
 * offered "Session materials" on every appointment and the POST rejected every
 * press. Which intents are OFFERED is the flow registry's decision; these
 * schemas only have to accept whatever it can emit, so no narrowing applies.
 *
 * Guarded in both directions without importing the Prisma client at runtime
 * (this module is pulled into client bundles and jsdom tests):
 *   - `satisfies` below fails to compile on a typo or a removed member;
 *   - __tests__/support/intent-offer-accept-parity.test.ts runs in the node
 *     environment and fails if Prisma gains a member missing from these lists.
 */
const SUPPORT_THREAD_CATEGORIES = [
  "CANCEL_REFUND",
  "RESCHEDULE",
  "NO_SHOW",
  "TECHNICAL",
  "DOCUMENTS",
  "PAYMENT_STATUS",
  "RECORDING_ACCESS",
  "QUALITY_COMPLAINT",
  "SPONSORSHIP_BILLING",
  "ORG_ADMIN_DISPUTE",
  "SAFETY_CONCERN",
  "OTHER",
] as const satisfies readonly SupportThreadCategory[];

const SUPPORT_CASE_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const satisfies readonly SupportCaseStatus[];

export const SupportThreadCategoryEnum = z.enum(SUPPORT_THREAD_CATEGORIES);
export const SupportCaseStatusEnum = z.enum(SUPPORT_CASE_STATUSES);

/** Every terminal `reason` of the appointment flows (lib/support/flows.ts), as `SupportCase.flowReason` stores it. */
export const SupportFlowReasonEnum = z.enum([
  "provider_no_show",
  "attendee_join_issue",
  "attendee_attended",
  "attendee_no_show",
  "provider_join_issue",
  "provider_attended",
  "payment_deducted_unconfirmed",
  "double_charge",
  "refund_missing",
  "gst_invoice_wrong",
  "recording_missing",
  "recording_broken",
  "quality_ended_early",
  "quality_poor",
  "quality_av",
  "quality_wrong_expert",
  "quality_other",
  "timezone_mismatch",
  "technical_unresolved",
  "sponsorship_charge",
  "org_billing_dispute",
  "org_conduct_dispute",
  "org_operator_human",
  "documents_missing",
  "documents_wrong",
  "documents_removal",
  "safety_threat",
  "fraud_scam",
  "safety_other",
]);
export type SupportFlowReason = z.infer<typeof SupportFlowReasonEnum>;

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
  "TAX_GST",
  "TDS_CERTIFICATE",
  "PAN_CARD_MISMATCH",
  "DOCUMENT_ISSUE",
  "WANT_TO_CANCEL",
  "CANCELLATION_ISSUE",
  "ACCOUNT_ISSUE",
  "GENERAL_INQUIRY",
  "OTHER",
]);

/** Statuses a client may request via PATCH /api/trials/[trialId]; only the capture webhook confirms a trial. */
export const TrialSessionStatusEnum = z.enum([
  "COMPLETED",
  "CONVERTED",
  "CANCELLED",
]);

export const RequestStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "APPROVED_PENDING_PAYMENT",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

export const RatingCauseSchema = z.enum([
  "CONSULTANT",
  "PLATFORM_TECHNICAL",
  "PAYMENT",
  "SCHEDULING",
  "CONTENT",
  "OTHER",
]);
export type RatingCause = z.infer<typeof RatingCauseSchema>;

export const PlatformFeedbackStatusSchema = z.enum([
  "PENDING",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);
export type PlatformFeedbackStatus = z.infer<
  typeof PlatformFeedbackStatusSchema
>;
