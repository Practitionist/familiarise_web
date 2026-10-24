import { ModerationReportStatus, ModerationReportType } from "@prisma/client";
import { z } from "zod";
import { PlatformFeedbackStatusSchema } from "@/schemas/enums";
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

export const CreateReportSchema = z
  .object({
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
  })
  .superRefine((val, ctx) => {
    if (
      val.type === "REVIEW" &&
      !ReviewReportReasonValueSchema.safeParse(val.reason).success
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Invalid review report reason",
      });
    }
  });

export type CreateReportInput = z.infer<typeof CreateReportSchema>;

/**
 * Direct report status PATCH only allows triage state transitions.
 * Terminal dispositions (DISMISSED / ACTION_TAKEN) must go through `/action`.
 */
export const PatchReportSchema = z.object({
  status: z.enum([
    "PENDING",
    "UNDER_REVIEW",
    "ESCALATED",
  ] as const satisfies readonly ModerationReportStatus[]),
  resolution: z.string().optional(),
});

export type PatchReportInput = z.infer<typeof PatchReportSchema>;

export const PatchFeedbackSchema = z.object({
  status: PlatformFeedbackStatusSchema,
  staffNote: z.string().optional(),
});

export type PatchFeedbackInput = z.infer<typeof PatchFeedbackSchema>;

/** The categories staff may open a support case under from a moderation report. */
export const ReportCaseCategorySchema = z.enum([
  "SAFETY_CONCERN",
  "QUALITY_COMPLAINT",
  "OTHER",
]);

export type ReportCaseCategory = z.infer<typeof ReportCaseCategorySchema>;

/** Body of the open-case door; the ops shell adds the required `reason`. */
export const OpenReportCaseShape = {
  appointmentId: z.string().trim().min(1).max(64),
  category: ReportCaseCategorySchema,
};

/** A booking both the reporter and the reported user are parties to. */
export const ReportCaseCandidateSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  startsAt: z.string().nullable(),
  /** False when the report names a chat and this booking's chat is another one. */
  chatMatchesReport: z.boolean().nullable(),
});

export const LinkedReportCaseSchema = z.object({
  id: z.string(),
  referenceNumber: z.string(),
});

export const ReportCaseOptionsSchema = z.object({
  linkedCase: LinkedReportCaseSchema.nullable(),
  candidates: z.array(ReportCaseCandidateSchema),
});

export type ReportCaseOptions = z.infer<typeof ReportCaseOptionsSchema>;
export type LinkedReportCase = z.infer<typeof LinkedReportCaseSchema>;
