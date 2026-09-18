/**
 * Customer-facing copy for the verification review vocabulary. The reason
 * codes live on `ProfileVerificationDocument.issue`; staff pick one for every
 * document they flag, and the consultant reads the sentence, never the code.
 */

import type { VerificationDocumentIssue } from "@prisma/client";

export const VERIFICATION_DOCUMENT_ISSUE_LABEL: Record<
  VerificationDocumentIssue,
  string
> = {
  UNCLEAR_SCAN: "Unclear or unreadable scan",
  EXPIRED: "Document has expired",
  NAME_MISMATCH: "Name does not match the profile",
  MISSING_PAGE: "A page is missing",
  WRONG_TYPE: "Not the kind of document we need",
  OTHER: "Other (see note)",
};

/** What the consultant should do about each reason. */
export const VERIFICATION_DOCUMENT_ISSUE_FIX: Record<
  VerificationDocumentIssue,
  string
> = {
  UNCLEAR_SCAN: "Upload a sharper, well-lit scan or photo of the whole page.",
  EXPIRED: "Upload the current, unexpired version of this document.",
  NAME_MISMATCH:
    "Upload a document in the same name as your profile, or update your profile name.",
  MISSING_PAGE: "Upload every page of the document, including the back.",
  WRONG_TYPE: "Upload the document type the reviewer asked for.",
  OTHER: "Read the reviewer's note and upload a corrected document.",
};

export const VERIFICATION_DOCUMENT_ISSUE_VALUES = Object.keys(
  VERIFICATION_DOCUMENT_ISSUE_LABEL,
) as VerificationDocumentIssue[];
