import {
  ModerationReportStatus,
  ModerationReportType,
  type ModerationReason,
} from "@prisma/client";
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

/**
 * Every ground a report can be filed on.
 *
 * The machine-readable code is what the database stores in
 * `ModerationReport.reasonCode`; the label beside it is what the queue and
 * the notice to the parties read. `reason` keeps the label, so a report
 * written before the typed code existed (which stored the code in `reason`)
 * and one written now read the same way.
 *
 * The list is written out rather than read off the generated enum so the
 * schema does not depend on the client being regenerated to load.
 */
export const MODERATION_REASON_CODES = [
  "COERCION_OR_RETALIATION",
  "SPAM_OR_FAKE",
  "HARASSMENT_OR_ABUSE",
  "OFF_TOPIC",
  "IMAGINARY_LISTING",
  "INAPPROPRIATE_CONTENT",
  "OFF_PLATFORM_SOLICITATION",
  "PRIVACY_VIOLATION",
  "FRAUD_OR_SCAM",
  "OTHER",
] as const;

/** The typed ground a report is filed on. */
export const ModerationReasonValueSchema = z.enum(MODERATION_REASON_CODES);
export type ModerationReasonValue = z.infer<typeof ModerationReasonValueSchema>;

/**
 * The label of every ground. Typed over the DATABASE enum, so a ground the
 * database knows and this file does not is a compile error rather than a row
 * nobody can explain.
 */
export const MODERATION_REASON_LABELS: Record<ModerationReason, string> = {
  COERCION_OR_RETALIATION: "Coercion, extortion, or retaliatory pressure",
  SPAM_OR_FAKE: "Spam or unverified claim",
  HARASSMENT_OR_ABUSE: "Harassment or abusive language",
  OFF_TOPIC: "Irrelevant or off-topic",
  IMAGINARY_LISTING: "Imaginary or fabricated listing",
  INAPPROPRIATE_CONTENT: "Inappropriate content",
  OFF_PLATFORM_SOLICITATION: "Soliciting contact or payment off-platform",
  PRIVACY_VIOLATION: "Privacy violation",
  FRAUD_OR_SCAM: "Fraud or scam",
  OTHER: "Other policy concern",
};

/**
 * Which grounds each kind of report may be filed on.
 *
 * A review report is about what somebody wrote about a session; a message
 * report is about what somebody said in a channel; a document report is about
 * a file. They share the abuse grounds and differ on the rest: nobody can
 * claim an "imaginary listing" about a chat message.
 */
export const REPORT_REASON_CODES_BY_TYPE: Record<
  ModerationReportType,
  readonly ModerationReasonValue[]
> = {
  REVIEW: REVIEW_REPORT_REASONS.map((option) => option.value),
  PROFILE: [
    "SPAM_OR_FAKE",
    "IMAGINARY_LISTING",
    "HARASSMENT_OR_ABUSE",
    "INAPPROPRIATE_CONTENT",
    "OFF_PLATFORM_SOLICITATION",
    "PRIVACY_VIOLATION",
    "FRAUD_OR_SCAM",
    "OTHER",
  ],
  MESSAGE: [
    "COERCION_OR_RETALIATION",
    "SPAM_OR_FAKE",
    "HARASSMENT_OR_ABUSE",
    "INAPPROPRIATE_CONTENT",
    "OFF_PLATFORM_SOLICITATION",
    "PRIVACY_VIOLATION",
    "FRAUD_OR_SCAM",
    "OTHER",
  ],
  DOCUMENT: [
    "SPAM_OR_FAKE",
    "INAPPROPRIATE_CONTENT",
    "PRIVACY_VIOLATION",
    "FRAUD_OR_SCAM",
    "OTHER",
  ],
  OTHER: MODERATION_REASON_CODES,
};

/**
 * The typed ground and the human label for a submitted reason.
 *
 * A reason that names a ground this kind of report may be filed on carries
 * that ground's code; free text (the chat's "Reported message") is filed
 * under OTHER with the text as its label, so `reasonCode` is never null and
 * never claims a ground nobody chose.
 */
export function resolveReportReason(
  type: ModerationReportType,
  reason: string,
): { code: ModerationReasonValue; label: string } {
  const known = REPORT_REASON_CODES_BY_TYPE[type].find(
    (code) => code === reason,
  );
  if (known) return { code: known, label: MODERATION_REASON_LABELS[known] };
  const anywhere = MODERATION_REASON_CODES.find((code) => code === reason);
  if (anywhere)
    return { code: anywhere, label: MODERATION_REASON_LABELS[anywhere] };
  return { code: "OTHER", label: reason };
}

const REASON_CODES = new Set<string>(MODERATION_REASON_CODES);

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
    const vocabulary: readonly string[] = REPORT_REASON_CODES_BY_TYPE[val.type];
    if (vocabulary.includes(val.reason)) return;
    // A ground that exists but does not belong to this kind of report is a
    // mistake in the caller, not free text: refuse it rather than filing it
    // under a ground nobody chose.
    if (REASON_CODES.has(val.reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `Invalid reason for a ${val.type} report`,
      });
      return;
    }
    // Free text is a review report's refusal: a review is a claim about a
    // named person, so it must name the ground it is filed on.
    if (val.type === "REVIEW") {
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
 *
 * The disposition is NOT accepted here: the database refuses a closed report
 * without a resolution and an open one with one, so the route derives the
 * resolution from the status instead of trusting a caller to send both
 * together.
 */
export const PatchReportSchema = z.object({
  status: z.enum([
    "PENDING",
    "UNDER_REVIEW",
    "ESCALATED",
  ] as const satisfies readonly ModerationReportStatus[]),
});

export type PatchReportInput = z.infer<typeof PatchReportSchema>;

export const PatchFeedbackSchema = z.object({
  status: PlatformFeedbackStatusSchema,
  /** The operator's own note. Staff-only: it never reaches the author. */
  staffNote: z.string().trim().max(MAX_TEXT_LENGTH).optional(),
});

export type PatchFeedbackInput = z.infer<typeof PatchFeedbackSchema>;
