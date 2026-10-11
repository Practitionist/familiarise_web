# Appointment Documents & Threaded Deliverable Review

> Canonical reference for appointment deliverable threads (`AppointmentDocument`), plan handouts (`PlanMaterial`), 2-phase presigned Supabase uploads, server-side magic-byte inspection, and streaming signed-URL downloads.

## Index

| #   | Document                                        | Scope                                                                                                         |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 01  | [Architecture & Invariants](01-architecture.md) | Threading model (`rootDocumentId`, `versionNo`), CAS state transitions, 2-phase direct upload, SQL pagination |

---

## Core Capabilities

1. **Threaded Deliverable Revisions (`AppointmentDocument`)**:
   - Every upload is either a **root document** (`rootDocumentId = null`, `versionNo = 1`) or a **child version** (`rootDocumentId = <rootId>`, `versionNo = 2..10`) linked to its immediate predecessor via `responseToDocumentId`.
   - Both learners (`uploadedByRole = CONSULTEE`) and experts (`uploadedByRole = CONSULTANT`) participate in the same ordered version timeline (`(appointmentId, COALESCE(rootDocumentId, id), versionNo)`).
   - Hard capacity limits prevent unbounded storage growth per session:
     - `MAX_DOCS_PER_APPOINTMENT = 20` active root threads (`rootDocumentId IS NULL AND deletedAt IS NULL`).
     - `MAX_VERSIONS_PER_THREAD = 10` total revisions/replies per root thread.
2. **2-Phase Presigned Upload with Magic-Byte Verification**:
   - **Phase 1 (`POST /api/appointments/[appointmentId]/documents/upload-url`)**: Authorizes the caller, runs a preflight cap check, sanitizes the object path (`appointments/{appointmentId}/{consultee|consultant}-{profileId}/{ts}_{name}`), and returns a single-use Supabase presigned upload URL with `XHR` upload progress reporting.
   - **Phase 2 (`POST /api/appointments/[appointmentId]/documents` or `/consultant`)**: Reads the first 4 KB range from Supabase Storage via `verifyDirectUploadedObject`, rejects binary executables (`MZ`, `ELF`, Mach-O) and header/MIME mismatches, locks the parent `"Appointment"` row (`FOR UPDATE`), reserves the next `(rootDocumentId, versionNo)` slot atomically inside `prisma.$transaction`, and cleans up the uploaded storage object automatically if database insertion fails.
3. **Zero-Buffering Presigned Downloads & Inline Preview**:
   - `GET /api/appointments/[appointmentId]/documents/[documentId]/download` validates caller participation and non-terminal session state (`CANCELLED`, `REJECTED`, `EXPIRED` are rejected with `403 APPOINTMENT_TERMINAL`), issues a 60-second Supabase signed URL (`Cache-Control: private, no-store`), and either responds with `{ signedUrl, mimeType, originalName, previewable }` (`?format=json`) or HTTP `302` redirects directly to object storage without buffering bytes in serverless memory.

---

## Key Code Locations

| Module                                                           | Responsibility                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `lib/documents/document-review.ts`                               | Thread aggregation (`groupDocumentsIntoThreads`), SQL root-thread filter, version slot helper |
| `lib/documents/upload-pipeline.ts`                               | Shared JSON/FormData request parser, preflight limit check, serialized `FOR UPDATE` inserter  |
| `lib/documents/storage-verify.ts`                                | Magic-byte header rules, direct upload object verification, 60-second signed URL issuance     |
| `lib/documents/direct-upload.ts`                                 | Browser client helper (`uploadAppointmentDocumentWithProgress`) with multipart fallback       |
| `lib/data/consultee-documents.ts`                                | SQL-paginated consultee root-thread reader (`readConsulteeDocuments`) + plan material reader  |
| `app/api/appointments/[appointmentId]/documents/`                | Upload (`POST`), consultant reply (`consultant/POST`), patch/delete (`[documentId]`), preview |
| `app/api/dashboard/consultant/[consultantId]/documents/route.ts` | SQL-paginated consultant document review feed with organization scope enforcement             |
| `components/documents/DocumentReviewDrawer.tsx`                  | Split-screen live preview + version switcher + consultant status/notes/attachment drawer      |
| `scripts/cleanup/reconcile-document-storage.ts`                  | Nightly bucket reconciliation (`isStorageMissing` detection + 7-day orphan cleanup)           |

---

## Deprecated & Superseded Approaches

> [!WARNING]
> **Do NOT re-introduce these patterns.**

1. **Public Storage URLs & `placeholder.com` Seed Artifacts**: Earlier iterations stored public Supabase bucket URLs in `AppointmentDocument.fileUrl` and seeded `https://placeholder.com/documents/...` URLs. All private documents now live in the private `documents` bucket and resolve exclusively through authenticated `/api/appointments/[appointmentId]/documents/[documentId]/download` endpoints backed by short-lived signed URLs.
2. **Server-Side Byte Proxy Buffering (`arrayBuffer()` in Next.js Route Handlers)**: Streaming binary files through Netlify serverless functions exhausted function memory on multi-megabyte PDFs and DOCX attachments. Download and inline preview routes now issue 60-second signed Supabase URLs (`302` redirect or `?format=json`).
3. **In-Memory Full-Table Thread Grouping Before Pagination**: Previously, dashboard readers queried all `AppointmentDocument` rows without `rootDocumentId: null` filtering, grouped threads in JavaScript memory, and sliced pages afterward — truncating multi-version threads or exhausting serverless memory. Both consultant and consultee readers now query `rootDocumentId: null` with SQL `skip`/`take` and eager `threadVersions` loading via `buildRootThreadStatusWhere`.
