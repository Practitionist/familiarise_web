import { DocumentReviewStatus } from "@prisma/client";

/**
 * Server-side document review invariants: per-appointment root thread count caps,
 * per-thread version caps, upload gates, review status transitions, and thread
 * aggregation helpers.
 */

/** Hard ceiling on live (non-deleted) root deliverable threads per appointment. */
export const MAX_DOCS_PER_APPOINTMENT = 20;

/** Hard ceiling on revisions + consultant replies within a single deliverable thread. */
export const MAX_VERSIONS_PER_THREAD = 10;

/** Grace window before the nightly cleanup job purges soft-deleted rows. */
export const DOCUMENT_DELETE_GRACE_DAYS = 7;

/** Shared upload gates — one definition so both roles cannot drift apart. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "text/plain",
] as const;

export const ALLOWED_DOCUMENT_ACCEPT_ATTR =
  ".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.txt";

export type DocumentUploadValidation =
  | { ok: true }
  | {
      ok: false;
      code: "FILE_TOO_LARGE" | "UNSUPPORTED_FILE_TYPE";
      message: string;
    };

const ALLOWED_DOCUMENT_MIME_TYPE_SET: ReadonlySet<string> = new Set(
  ALLOWED_DOCUMENT_MIME_TYPES,
);

export function validateDocumentUpload(file: {
  size: number;
  type: string;
}): DocumentUploadValidation {
  if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `Please select a file larger than 0 bytes and smaller than ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB.`,
    };
  }
  if (!ALLOWED_DOCUMENT_MIME_TYPE_SET.has(file.type)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message:
        'The file type "' +
        file.type +
        '" is not supported. Please upload a PDF, Word document, image (JPG, PNG, GIF), or text file.',
    };
  }
  return { ok: true };
}

export type ReviewStatus = keyof typeof DocumentReviewStatus;

const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  PENDING: ["IN_REVIEW", "APPROVED", "REJECTED", "NEEDS_REVISION"],
  IN_REVIEW: ["PENDING", "APPROVED", "REJECTED", "NEEDS_REVISION"],
  NEEDS_REVISION: ["PENDING", "IN_REVIEW", "APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

export function isReviewTransitionAllowed(
  from: ReviewStatus,
  to: ReviewStatus,
): boolean {
  if (from === to) return true;
  return REVIEW_TRANSITIONS[from].includes(to);
}

export async function withVersionConflictRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (
        attempt < 2 &&
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
      ) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

export interface ThreadableDocument {
  id: string;
  appointmentId: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl?: string;
  description?: string | null;
  reviewStatus: string;
  reviewNotes?: string | null;
  reviewedAt?: Date | string | null;
  uploadedByRole: string;
  uploadedAt: Date | string;
  versionNo?: number | null;
  rootDocumentId?: string | null;
  responseToDocumentId?: string | null;
}

export interface DocumentThread<
  T extends ThreadableDocument = ThreadableDocument,
> {
  rootId: string;
  appointmentId: string;
  title: string;
  latestVersion: T;
  latestConsulteeSubmission: T | null;
  latestConsultantResponse: T | null;
  effectiveStatus: string;
  effectiveReviewNotes: string | null;
  versions: T[];
  versionCount: number;
  updatedAt: Date | string;
}

/**
 * Groups flat `AppointmentDocument` rows by `COALESCE(rootDocumentId, id)` so
 * multi-round revisions (`v1 -> consultant reply v2 -> learner v3`) render as a
 * single deliverable thread instead of exploding into separate top-level rows.
 */
export function groupDocumentsIntoThreads<T extends ThreadableDocument>(
  documents: readonly T[],
): DocumentThread<T>[] {
  const byRoot = new Map<string, T[]>();

  for (const doc of documents) {
    const rootId = doc.rootDocumentId ?? doc.id;
    const list = byRoot.get(rootId);
    if (list) {
      list.push(doc);
    } else {
      byRoot.set(rootId, [doc]);
    }
  }

  const threads: DocumentThread<T>[] = [];

  for (const [rootId, items] of byRoot.entries()) {
    const versions = [...items].sort((a, b) => {
      const va = a.versionNo ?? 1;
      const vb = b.versionNo ?? 1;
      if (va !== vb) return va - vb;
      return (
        new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime()
      );
    });

    const latestVersion = versions.at(-1)!;
    let latestConsulteeSubmission: T | null = null;
    let latestConsultantResponse: T | null = null;
    let latestNotes: string | null = null;

    for (const v of versions) {
      if (v.uploadedByRole === "CONSULTEE") {
        latestConsulteeSubmission = v;
      } else {
        latestConsultantResponse = v;
      }
      if (v.reviewNotes && v.reviewNotes.trim().length > 0) {
        latestNotes = v.reviewNotes;
      }
    }

    const effectiveStatus =
      latestConsulteeSubmission?.reviewStatus ?? latestVersion.reviewStatus;

    threads.push({
      rootId,
      appointmentId: latestVersion.appointmentId,
      title:
        latestConsulteeSubmission?.originalName ?? latestVersion.originalName,
      latestVersion,
      latestConsulteeSubmission,
      latestConsultantResponse,
      effectiveStatus,
      effectiveReviewNotes: latestNotes,
      versions,
      versionCount: versions.length,
      updatedAt: latestVersion.uploadedAt,
    });
  }

  return threads.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}
