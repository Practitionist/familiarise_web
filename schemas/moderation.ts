import { ModerationReportType } from "@prisma/client";
import { z } from "zod";
import { MAX_TEXT_LENGTH, MAX_TITLE_LENGTH } from "@/lib/validation/limits";

/** The reasons an expert or host organization admin can pick when reporting a review. */
export const REVIEW_REPORT_REASONS = [
  {
    value: "COERCION_OR_RETALIATION",
    label: "Coercion, extortion, or retaliatory pressure",
  },
  { value: "SPAM_OR_FAKE", label: "Spam or unverified claim" },
  { value: "HARASSMENT_OR_ABUSE", label: "Harassment or abusive language" },
  { value: "OFF_TOPIC", label: "Irrelevant or off-topic" },
  { value: "OTHER", label: "Other policy concern" },
] as const;

export const ReviewReportReasonValueSchema = z.enum([
  "COERCION_OR_RETALIATION",
  "SPAM_OR_FAKE",
  "HARASSMENT_OR_ABUSE",
  "OFF_TOPIC",
  "OTHER",
]);

export type ReviewReportReasonValue = z.infer<
  typeof ReviewReportReasonValueSchema
>;

export const CreateReportSchema = z.object({
  type: z.nativeEnum(ModerationReportType),
  reason: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  targetUserId: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  contentText: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
  contentUrl: z.string().max(MAX_TITLE_LENGTH).optional(),
  reviewId: z.string().max(MAX_TITLE_LENGTH).optional(),
  organizationId: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  streamMessageId: z.string().max(MAX_TITLE_LENGTH).optional(),
  streamChannelCid: z.string().max(MAX_TITLE_LENGTH).optional(),
});

export type CreateReportInput = z.infer<typeof CreateReportSchema>;

/**
 * Direct report status PATCH only allows triage state transitions.
 * Terminal dispositions (DISMISSED / ACTION_TAKEN) must go through `/action`.
 */
export const PatchReportSchema = z.object({
  status: z.enum(["PENDING", "UNDER_REVIEW", "ESCALATED"]),
  resolution: z.string().optional(),
});

export type PatchReportInput = z.infer<typeof PatchReportSchema>;

export const PatchFeedbackSchema = z.object({
  status: z.enum([
    "PENDING",
    "ACKNOWLEDGED",
    "IN_PROGRESS",
    "RESOLVED",
    "CLOSED",
  ]),
});

export type PatchFeedbackInput = z.infer<typeof PatchFeedbackSchema>;
