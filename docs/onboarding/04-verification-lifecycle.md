---
title: Verification lifecycle
band: onboarding
audience: sde1
status: live
last-reviewed: 2026-09-18
---

# Verification lifecycle

A consultant is listed on the marketplace and bookable only once platform staff have verified their identity and credentials (`ConsultantProfile.verificationStatus = VERIFIED`; `lib/data/explore-experts.ts` filters on it and `assertPlanPurchasable` in checkout refuses anything else). This document is the lifecycle of that verification as rebuilt on 2026-09-18: where documents live and who owns them, the one writer for a submission, the one writer for a decision, how the staff–consultant loop is bounded, and what the daily sweep does. The wizard's part (collecting the documents at step 3) is in [01-system-reference.md](01-system-reference.md) §7.

## Two status columns

The table below explains the two enums involved, which are often confused.

| Column                                 | Values                                                         | Meaning                                                                               |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ConsultantProfile.verificationStatus` | `PENDING_VERIFICATION`, `UNDER_REVIEW`, `VERIFIED`, `REJECTED` | The profile's public standing. Reads gate on it.                                      |
| `ConsultantProfileVerification.status` | `PENDING`, `NEEDS_INFO`, `APPROVED`, `REJECTED`, `SUPERSEDED`  | One request row per submission. The open one is the queue item; the rest are history. |

A decision maps request → profile as `APPROVED → VERIFIED`, `REJECTED → REJECTED`, `NEEDS_INFO → PENDING_VERIFICATION` (`PROFILE_STATUS_FOR_DECISION` in `lib/verification/review.ts`). A submission moves the profile to `UNDER_REVIEW`.

## Documents

Every upload through `POST /api/verification/documents` creates a `ProfileVerificationDocument` row immediately, with `uploadedByUserId` set and `verificationId` null. Before 2026-09-18 an upload made from the wizard created no row at all: nothing owned it, nothing could count it, nothing could delete or sweep it, and the onboarding-completion path linked any document id it was handed (#1224). The row is now the unit of ownership, and a submission links rows to a request only when `uploadedByUserId` is the caller and `verificationId` is still null. Because every upload has a row, the onboarding-completion adapter links server-issued ids and nothing else: a draft saved before the change may still hold an id-less "onboarding upload" entry, and such an entry is simply not persistable, so the completion defers verification and the consultant re-uploads from Settings rather than the server minting a row from client-supplied metadata.

The upload route defends storage in four layers, listed in the order they run: the declared type and the 10 MB size, then the file's first bytes (`lib/storage/sniff-mime.ts` — a renamed executable arrives as `application/pdf`, the bytes do not), then a pre-flight of the caller's counters, then the same counters re-read inside the Serializable transaction that inserts the row so a burst of parallel uploads cannot each see "one below the cap". The counters are a 40 MB lifetime quota per user (the sum of `fileSize` across their rows), at most 5 unlinked uploads outstanding, and at most 10 documents on one request (`lib/verification/documents.ts`). The rate limiter from #1698 (10 per minute) bounds the rate; the quota bounds the total.

A document is opened through `GET /api/verification/documents/[id]/download`, which checks that the caller is the uploader, the consultant whose request it belongs to, or platform ADMIN/STAFF, and streams the object from the private bucket. Only the four byte-verified types (`application/pdf`, `image/png`, `image/jpeg`, `image/webp`) render inline; a row whose declared type is anything else — possible for uploads that predate the sniff — is served as an `application/octet-stream` attachment, so a stored HTML or SVG body can never execute on the application origin. The stored `fileUrl` used to be a one-hour signed URL produced at upload time; staff review a request days later, so every stored link had expired by the time anyone clicked it. New rows store the download path; reads of old rows are rewritten to it (`withDownloadUrls` in `lib/verification/review-route.ts`).

## Submitting

`lib/verification/submit-request.ts::submitVerificationRequest` is the only writer, called from onboarding completion, `POST /api/verification/submit` and `POST /api/verification/resubmit`. The table below lists what it does inside one Serializable transaction and the refusal each step can produce.

| Step             | What happens                                                                                                                                         | Refusal                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Claim            | `updateMany` moves the profile from `PENDING_VERIFICATION` or `REJECTED` to `UNDER_REVIEW`. A second concurrent call finds no row to move.           | `NOT_SUBMITTABLE` (409)     |
| Supersede        | The open `PENDING` / `NEEDS_INFO` request becomes `SUPERSEDED`; a new `PENDING` row is created. History is append-only: a round is a row.            | —                           |
| Link             | The caller's listed document ids are attached where `uploadedByUserId` matches and `verificationId` is null; a count mismatch rolls everything back. | `DOCUMENTS_NOT_OWNED` (403) |
| Carry over       | On a re-file, documents of the previous request that staff did not flag are moved onto the new one, so only what was flagged is re-uploaded.         | —                           |
| Require evidence | A request with no document is refused.                                                                                                               | `NO_DOCUMENTS` (400)        |

The admin/staff "new application" bells are staged inside the same transaction (`lib/verification/notify-admins.ts`, called by the writer with `tx`), so the queue item and its notice exist together or not at all; the vendor attempts run inside `after()`. If the onboarding-completion path fails to file the request, the profile stays `PENDING_VERIFICATION`, the failure is captured in Sentry under `subsystem: onboarding`, and the response says so; the consultant finishes from Settings → Verification (#698 OB-3, no longer silent).

## Deciding

`lib/verification/review.ts::reviewVerification` is the only writer, behind both `PATCH /api/staff/moderation/profiles/[id]` and `PATCH /api/admin/verification/[id]` (which previously carried two copies of the same body and no transition guard). It CASes the request row from an open state, so an `APPROVED` or `REJECTED` row cannot be decided again (`ALREADY_DECIDED`, 409); `NEEDS_INFO` may be closed with a final decision but not asked again. Every document marked invalid must carry a reason code from `VerificationDocumentIssue` (`UNCLEAR_SCAN`, `EXPIRED`, `NAME_MISMATCH`, `MISSING_PAGE`, `WRONG_TYPE`, `OTHER`) — the schema and the core both refuse without one (`ISSUE_REQUIRED`, 400) — and the consultant reads the sentence for each code from `lib/labels/verification-labels.ts`. The profile status follows the decision, the completion score is recomputed, and the consultant's bell and `VERIFICATION_DECIDED` email are staged in the same transaction. The bell names the decision (`VERIFIED`, `REJECTED` or `NEEDS_INFO`) rather than the profile enum, because the profile goes back to `PENDING_VERIFICATION` on `NEEDS_INFO` and a bell that said "pending review" would hide the request for more information; the email keeps the profile enum, which its template already renders as that request. The route purges the public surfaces and runs the vendor attempts inside `after()`.

## Bounding the loop

A request for more information is a round. Rounds are counted as request rows since the last `APPROVED` / `REJECTED` decision that carry a `reviewedAt` (a `NEEDS_INFO` the consultant answered becomes a `SUPERSEDED` row with a `reviewedAt`; a `SUPERSEDED` row with none was a re-file while still `PENDING`, not a round). After three answered rounds the next staff action must be `APPROVED` or `REJECTED` (`ROUND_CAP`, 409). A `NEEDS_INFO` the consultant has not answered gets one reminder email after 7 days (`reminderSentAt` stamps it so it never repeats) and is closed as `REJECTED` after 14 days with a reason the consultant can act on; both are the daily sweep's work.

## The sweep

`scripts/cleanup/sweep-verification.ts` runs daily at 03:20 UTC through `.github/workflows/sweep-verification.yml` and its HTTP twin `POST /api/cleanup/sweep-verification`. It deletes unlinked uploads older than 7 days — the row first, guarded on `verificationId` still being null, then the object, so a submission that links the row between the read and the delete keeps both and the worst case of a failed object removal is one orphaned object rather than a linked row whose file is gone. It sends the day-7 reminder with the `reminderSentAt` stamp and the outbox row committed in one transaction (a stamp without a row would silence the reminder for good), and it closes the day-14 stale requests with the profile update and the decision bell and email staged in the same per-row transaction. It imports the storage leaf module (`lib/supabase-storage-core`) rather than `lib/supabase`, which carries `server-only` and cannot load in a bare Node process (#1270).

## Tests

`__tests__/verification/sniff-mime.test.ts`, `upload-admission.test.ts`, `submit-request.test.ts` (CAS, ownership, empty request) and `review.test.ts` (reason codes, CAS, round cap) pin the rules above; `__tests__/maintenance/workflow-import-env.test.ts` and `cron-lock-registry.test.ts` keep the sweep loadable and locked.
