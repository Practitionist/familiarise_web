---
title: Schema reference
band: onboarding
audience: sde1
status: live
last-reviewed: 2026-09-18
---

# Schema reference

This document carries the rationale for the onboarding and verification columns that the Prisma schema only names; the schema comments stay short by rule and point here. Models the wizard writes are listed in [01-system-reference.md](01-system-reference.md) §8.

## `ProfileVerificationDocument`

The table below explains each column changed or added on 2026-09-18.

| Column             | Type                                                                     | Why                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verificationId`   | `String?`                                                                | Was required, so an upload could not exist before a request did — which is exactly when the wizard uploads. Null means "uploaded, not yet submitted"; the sweep deletes such rows after 7 days. The relation is `onDelete: Cascade`, so deleting a request still takes its linked documents.                                                                |
| `uploadedByUserId` | `String?` (relation `VerificationDocumentUploader`, `onDelete: Cascade`) | The owner. Linking a document to a request requires it to equal the caller (#1224), and the 40 MB lifetime quota sums `fileSize` over it. Nullable only because rows written before the column existed have no owner; such a row cannot be re-linked, which is the safe direction, and the delete route falls back to the request's profile owner for them. |
| `linkedAt`         | `DateTime?`                                                              | When a submission attached the row; `uploadedAt` keeps the upload time. Together they measure how long applicants sit on uploads before filing.                                                                                                                                                                                                             |
| `issue`            | `VerificationDocumentIssue?`                                             | The reason code staff attach when they mark the document invalid. Structured so the consultant's fix list is sentences from `lib/labels/verification-labels.ts`, and so a re-file can carry over exactly the documents with no issue.                                                                                                                       |
| `fileUrl`          | `String` (unchanged)                                                     | New rows store the app-relative download route rather than a signed URL. The column is kept, not dropped, because a drop is a schema change with no benefit before the pre-MVP reset.                                                                                                                                                                       |

`@@index([uploadedByUserId])` serves the quota aggregate and the outstanding-upload count.

## `ConsultantProfileVerification`

| Column           | Type        | Why                                                                                                                                                                                                               |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reminderSentAt` | `DateTime?` | Stamped by the sweep when the day-7 reminder for an unanswered `NEEDS_INFO` goes out; the sweep CASes on the null so a concurrent run cannot send twice. Cleared by nothing — a superseded row keeps its history. |

## `VerificationDocumentIssue`

`UNCLEAR_SCAN`, `EXPIRED`, `NAME_MISMATCH`, `MISSING_PAGE`, `WRONG_TYPE`, `OTHER`. The enum sits after the model that uses it, as the schema convention requires. `OTHER` exists so the free-text `staffFeedback` still has a home; it should be rare, and a reason that keeps appearing as `OTHER` is a candidate for its own value.

## `User.verificationDocumentsUploaded`

The back-relation for `uploadedByUserId`, named so the erasure pipeline (DPDP §12) takes a user's uploads with the user.

## Applying the change

The change is additive (two nullable columns, one widened to nullable, one enum, one index). On the single Supabase project it is applied with `prisma db push` before the code deploys — the build prerenders against the live database — followed by `npm run db:sidecars`, because a push can revert the hand-applied sidecars and CI's drift guard fails every pull request until they are re-asserted.
