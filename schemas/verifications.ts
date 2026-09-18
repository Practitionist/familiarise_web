import { z } from "zod";
import { VerificationDocumentIssue } from "@prisma/client";

export const ReviewVerificationSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "NEEDS_INFO"]),
  reviewNotes: z.string().optional(),
  rejectionReason: z.string().optional(),
  feedbackDetails: z.string().optional(),
  documentFeedback: z
    .array(
      z
        .object({
          documentId: z.string(),
          isValid: z.boolean(),
          staffFeedback: z.string().optional(),
          // A flagged document carries a reason code so the applicant knows
          // what to fix (docs/onboarding/04-verification-lifecycle.md).
          issue: z.nativeEnum(VerificationDocumentIssue).optional(),
        })
        .refine((d) => d.isValid || Boolean(d.issue), {
          message: "Pick a reason for every document marked invalid",
          path: ["issue"],
        }),
    )
    .optional(),
});

/**
 * POST /api/verification/submit body. Unvalidated JSON used to reach the
 * destructure: a null body throws on destructure and an exotic documentIds
 * (e.g. a string, which `new Set` would split into chars) falls through to
 * a 403/500 later. The route safeParses at the boundary and returns a
 * generic 400 on failure.
 */
export const VerificationSubmitSchema = z
  .object({
    linkedinUrl: z.string().max(2048).optional(),
    notes: z.string().max(2000).optional(),
    documentIds: z.array(z.string().min(1)).max(10).optional(),
  })
  .strict();
