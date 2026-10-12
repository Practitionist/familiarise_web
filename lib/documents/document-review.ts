import { DocumentReviewStatus } from "@prisma/client";
import type { PrismaLike } from "@/lib/prisma";

/**
 * Document thread invariants: the per-booking document cap, the learner
 * version gate, review status transitions and version-slot allocation.
 */

/** Hard ceiling on live (non-deleted) root deliverable threads per appointment. */
export const MAX_DOCS_PER_APPOINTMENT = 20;

/** Live learner versions per thread; expert replies do not count. */
export const MAX_LEARNER_VERSIONS_PER_THREAD = 10;

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
  rootDocument: T;
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

    const rootDocument = versions[0]!;
    const latestVersion = versions.at(-1)!;
    let latestConsulteeSubmission: T | null = null;
    let latestConsultantResponse: T | null = null;

    for (const v of versions) {
      if (v.uploadedByRole === "CONSULTEE") {
        latestConsulteeSubmission = v;
      } else {
        latestConsultantResponse = v;
      }
    }
    // Feedback belongs to the version it reviewed, so a newer learner version starts clean.
    const latestNotes =
      (latestConsulteeSubmission ?? latestVersion).reviewNotes?.trim() || null;

    const effectiveStatus =
      latestConsulteeSubmission?.reviewStatus ?? latestVersion.reviewStatus;

    threads.push({
      rootId,
      rootDocument,
      appointmentId: latestVersion.appointmentId,
      title: rootDocument.originalName,
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

/** Expert rows are replies (or the expert's own shared file), never a reviewed status. */
export function versionAuthorLabel(
  version: Pick<ThreadableDocument, "id" | "uploadedByRole">,
  rootId: string,
  viewerRole: "consultee" | "consultant",
): string {
  if (version.uploadedByRole === "CONSULTANT") {
    return version.id === rootId ? "Shared by expert" : "Expert reply";
  }
  return viewerRole === "consultee" ? "Your version" : "Learner version";
}

type LearnerRevisionGate =
  | { allowed: true }
  | {
      allowed: false;
      code: "THREAD_CLOSED" | "THREAD_IN_REVIEW" | "VERSION_LIMIT_REACHED";
    };

/**
 * Whether the learner may add a version: only on a learner thread whose latest
 * live learner version is PENDING or NEEDS_REVISION, under the learner-version cap.
 */
export function learnerRevisionGate(
  rootUploadedByRole: string,
  liveVersions: readonly {
    uploadedByRole: string;
    reviewStatus: string;
    versionNo?: number | null;
  }[],
): LearnerRevisionGate {
  if (rootUploadedByRole !== "CONSULTEE") {
    return { allowed: false, code: "THREAD_CLOSED" };
  }
  const learnerVersions = liveVersions.filter(
    (v) => v.uploadedByRole === "CONSULTEE",
  );
  const latest = learnerVersions.reduce<
    (typeof learnerVersions)[number] | null
  >(
    (best, v) =>
      !best || (v.versionNo ?? 1) > (best.versionNo ?? 1) ? v : best,
    null,
  );
  if (!latest) return { allowed: false, code: "THREAD_CLOSED" };
  if (latest.reviewStatus === "IN_REVIEW") {
    return { allowed: false, code: "THREAD_IN_REVIEW" };
  }
  if (
    latest.reviewStatus !== "PENDING" &&
    latest.reviewStatus !== "NEEDS_REVISION"
  ) {
    return { allowed: false, code: "THREAD_CLOSED" };
  }
  if (learnerVersions.length >= MAX_LEARNER_VERSIONS_PER_THREAD) {
    return { allowed: false, code: "VERSION_LIMIT_REACHED" };
  }
  return { allowed: true };
}

export type ThreadSlotErrorCode =
  | "DOCUMENT_LIMIT_REACHED"
  | "INVALID_THREAD_PARENT"
  | "THREAD_CLOSED"
  | "THREAD_IN_REVIEW"
  | "VERSION_LIMIT_REACHED";

type ThreadSlotOutcome =
  | { ok: true; rootDocumentId: string | null; versionNo: number }
  | { ok: false; code: ThreadSlotErrorCode };

type ThreadSlotDb = Pick<PrismaLike, "appointmentDocument">;

/** Root/version slot for a new upload; learner versions pass `learnerRevisionGate`. */
export async function checkDocumentThreadSlot(
  db: ThreadSlotDb,
  params: {
    appointmentId: string;
    parentDocumentId: string | null | undefined;
    uploadedByRole: "CONSULTEE" | "CONSULTANT";
  },
): Promise<ThreadSlotOutcome> {
  const { appointmentId, parentDocumentId, uploadedByRole } = params;

  if (!parentDocumentId) {
    const rootCount = await db.appointmentDocument.count({
      where: { appointmentId, rootDocumentId: null, deletedAt: null },
    });
    if (rootCount >= MAX_DOCS_PER_APPOINTMENT) {
      return { ok: false, code: "DOCUMENT_LIMIT_REACHED" };
    }
    return { ok: true, rootDocumentId: null, versionNo: 1 };
  }

  const parent = await db.appointmentDocument.findFirst({
    where: { id: parentDocumentId, appointmentId, deletedAt: null },
    select: {
      id: true,
      rootDocumentId: true,
      uploadedByRole: true,
      rootDocument: { select: { uploadedByRole: true } },
    },
  });
  if (!parent) return { ok: false, code: "INVALID_THREAD_PARENT" };

  const rootDocumentId = parent.rootDocumentId ?? parent.id;
  const inThread = { OR: [{ id: rootDocumentId }, { rootDocumentId }] };

  if (uploadedByRole === "CONSULTEE") {
    const liveVersions = await db.appointmentDocument.findMany({
      where: { deletedAt: null, ...inThread },
      select: { uploadedByRole: true, reviewStatus: true, versionNo: true },
    });
    const gate = learnerRevisionGate(
      parent.rootDocument?.uploadedByRole ?? parent.uploadedByRole,
      liveVersions,
    );
    if (!gate.allowed) return { ok: false, code: gate.code };
  }

  const aggregate = await db.appointmentDocument.aggregate({
    where: inThread,
    _max: { versionNo: true },
  });
  return {
    ok: true,
    rootDocumentId,
    versionNo: (aggregate._max.versionNo ?? 1) + 1,
  };
}

export class ThreadSlotError extends Error {
  readonly code: ThreadSlotErrorCode;

  constructor(code: ThreadSlotErrorCode) {
    super(code);
    this.code = code;
    this.name = "ThreadSlotError";
  }
}

/** Slot allocation for the commit; call inside a transaction holding the booking's `FOR UPDATE` lock. */
export async function resolveDocumentThreadSlot(
  tx: ThreadSlotDb,
  params: {
    appointmentId: string;
    parentDocumentId: string | null | undefined;
    uploadedByRole: "CONSULTEE" | "CONSULTANT";
  },
): Promise<{ rootDocumentId: string | null; versionNo: number }> {
  const outcome = await checkDocumentThreadSlot(tx, params);
  if (!outcome.ok) throw new ThreadSlotError(outcome.code);
  return {
    rootDocumentId: outcome.rootDocumentId,
    versionNo: outcome.versionNo,
  };
}

/**
 * SQL-pushed `effectiveStatus` filter on root document threads (`rootDocumentId: null`):
 * matches threads whose highest-version live `CONSULTEE` upload has `reviewStatus = status`.
 */
export function buildRootThreadStatusWhere(
  baseRootWhere: Record<string, unknown>,
  status: DocumentReviewStatus | null | undefined,
): Record<string, unknown> {
  if (!status) return baseRootWhere;
  return {
    ...baseRootWhere,
    OR: [
      {
        threadVersions: {
          some: {
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            reviewStatus: status,
          },
        },
      },
      {
        reviewStatus: status,
        threadVersions: {
          none: {
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
          },
        },
      },
    ],
  };
}
