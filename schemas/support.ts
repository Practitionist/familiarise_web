import { z } from "zod";
import {
  SupportPriorityEnum,
  SupportIssueTypeEnum,
  SupportThreadCategoryEnum,
} from "./enums";
import {
  MAX_SHORT_FIELD_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/input-limits";
import { callbackPhoneSchema, stripCallbackTags } from "@/lib/validation/phone";

// #831 — every user-typed string carries a .max()
export const CreateSupportTicketSchema = z.object({
  title: z.string().min(1, "Title is required").max(MAX_TITLE_LENGTH),
  description: z
    .string()
    .min(1, "Description is required")
    .max(MAX_TEXT_LENGTH),
  callbackPhone: callbackPhoneSchema.optional(),
  priority: SupportPriorityEnum.optional(),
  category: z.string().max(MAX_SHORT_FIELD_LENGTH).optional(),
  issueType: SupportIssueTypeEnum.optional(),
  consultationId: z.string().optional(),
  subscriptionId: z.string().optional(),
  paymentId: z.string().optional(),
  appointmentId: z.string().optional(),
  // #1527 "About": an org the caller may raise requests for; checked server-side.
  organizationId: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Route param schemas — the ONE definition of "what an id looks like" for the
// support surface. Deliberately NOT .uuid()/.cuid(): ids are opaque strings
// (uuid in prod, readable slugs like `demo0813-apt-ba` in seeds), and the DB
// lookup is the real validator — a format check here only produced 400s that
// looked like data bugs. Length-bounded so garbage can't reach Prisma.
// ---------------------------------------------------------------------------

export const AppointmentIdParams = z.object({
  appointmentId: z.string().min(1).max(64),
});

export const OrgIdParams = z.object({
  orgId: z.string().min(1).max(64),
});

const OpaqueId = z.string().min(1).max(64);

export const CaseIdParams = z.object({ caseId: OpaqueId });

export const AttachmentIdParams = z.object({ attachmentId: OpaqueId });

export const EvidenceRequestIdParams = z.object({ requestId: OpaqueId });

export const CaseRecommendationParams = z.object({
  caseId: OpaqueId,
  recommendationId: OpaqueId,
});

/** Optional evidence-request scope on a case attachment list. */
export const CaseAttachmentQuery = z.object({
  evidenceRequestId: OpaqueId.optional(),
});

/** One turn of a booking's support conversation (`POST /api/appointments/[id]/support`). */
export const SupportTurnSchema = z
  .object({
    clientTurnId: z.string().min(1).max(128).optional(),
    category: SupportThreadCategoryEnum.optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z
      .string()
      .transform((s) => stripCallbackTags(s).trim())
      .pipe(z.string().max(2000))
      .optional(),
    urgent: z.boolean().optional(),
    /** "This didn't fix it" on a resolved human conversation; carries a message. */
    reopen: z.boolean().optional(),
    /** The session a retrospective intent is about; the route checks it belongs to the booking and has ended. */
    appointmentOccurrenceId: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.category || v.chosenOptionId || v.userMessage, {
    message: "A turn needs a category, a chosen option, or a message",
  })
  .refine((v) => !v.reopen || v.userMessage, {
    message: "Tell us what still isn't fixed",
    path: ["userMessage"],
  });
