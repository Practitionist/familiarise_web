/**
 * Server-built document threads: status from the latest live learner version,
 * the banner naming who acts next, and the actions the viewer may take. The UI
 * renders these and never decides. Client-safe (types and pure functions only).
 */

import type { DocumentPartyRole } from "./document-party";
import { MAX_LEARNER_VERSIONS_PER_THREAD } from "./document-review";

export type ThreadStatus =
  | "WAITING_FOR_EXPERT"
  | "IN_REVIEW"
  | "NEEDS_REVISION"
  | "APPROVED"
  | "NOT_ACCEPTED"
  | "SHARED";

export type ThreadAction =
  | "upload_version"
  | "withdraw_latest"
  | "review"
  | "delete_shared"
  | "request_removal";

export type ThreadBannerKind = ThreadStatus | "REMOVAL_REQUESTED";

export interface ThreadVersionView {
  id: string;
  versionNo: number;
  by: "learner" | "expert";
  label: "Your version" | "Learner version" | "Expert reply" | "Shared file";
  originalName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
  note: string | null;
  feedback: string | null;
  reviewStatus: string | null;
  reviewedAt: string | null;
  superseded: boolean;
  storageMissing: boolean;
}

export interface ThreadView {
  rootId: string;
  title: string;
  kind: "submission" | "shared";
  status: ThreadStatus;
  /** Copy is built on the client from the kind and the booking's two names. */
  banner: { kind: ThreadBannerKind; since: string; versionNo: number };
  removal: { requestedAt: string } | null;
  learnerVersions: { used: number; max: number };
  allowedActions: ThreadAction[];
  /** The latest live learner version, which a review acts on. */
  reviewTargetId: string | null;
  latestVersionNo: number;
  updatedAt: string;
  versions: ThreadVersionView[];
}

export interface ThreadRow {
  id: string;
  rootDocumentId: string | null;
  versionNo: number;
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  originalName: string;
  mimeType: string;
  fileSize: number;
  description: string | null;
  reviewStatus: string;
  reviewNotes: string | null;
  reviewedAt: Date | null;
  uploadedAt: Date;
  isStorageMissing: boolean;
  removalRequestedAt: Date | null;
}

export interface ThreadViewContext {
  viewerRole: DocumentPartyRole;
  /** Uploads, reviews and replies are allowed (booking confirmed, live, window open). */
  writable: boolean;
}

/** Prisma select for the rows a thread view is built from. */
export const threadRowSelect = {
  id: true,
  rootDocumentId: true,
  versionNo: true,
  uploadedByRole: true,
  originalName: true,
  mimeType: true,
  fileSize: true,
  description: true,
  reviewStatus: true,
  reviewNotes: true,
  reviewedAt: true,
  uploadedAt: true,
  isStorageMissing: true,
  removalRequestedAt: true,
} as const;

const STATUS_OF: Record<string, ThreadStatus> = {
  PENDING: "WAITING_FOR_EXPERT",
  IN_REVIEW: "IN_REVIEW",
  NEEDS_REVISION: "NEEDS_REVISION",
  APPROVED: "APPROVED",
  REJECTED: "NOT_ACCEPTED",
};

const OPEN_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "WAITING_FOR_EXPERT",
  "IN_REVIEW",
  "NEEDS_REVISION",
]);

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function versionLabel(
  row: ThreadRow,
  rootId: string,
  viewerRole: DocumentPartyRole,
): ThreadVersionView["label"] {
  if (row.uploadedByRole === "CONSULTANT") {
    return row.id === rootId ? "Shared file" : "Expert reply";
  }
  return viewerRole === "learner" ? "Your version" : "Learner version";
}

function buildThread(
  rootId: string,
  rows: ThreadRow[],
  ctx: ThreadViewContext,
): ThreadView {
  const versions = [...rows].sort((a, b) => a.versionNo - b.versionNo);
  const root = versions.find((v) => v.id === rootId) ?? versions[0]!;
  const latest = versions.at(-1)!;
  const learnerRows = versions.filter((v) => v.uploadedByRole === "CONSULTEE");
  const latestLearner = learnerRows.at(-1) ?? null;
  const kind = root.uploadedByRole === "CONSULTANT" ? "shared" : "submission";
  const status: ThreadStatus =
    kind === "shared" || !latestLearner
      ? "SHARED"
      : (STATUS_OF[latestLearner.reviewStatus] ?? "WAITING_FOR_EXPERT");

  const removal = root.removalRequestedAt
    ? { requestedAt: root.removalRequestedAt.toISOString() }
    : null;

  const actions: ThreadAction[] = [];
  const isLearner = ctx.viewerRole === "learner";
  if (kind === "submission") {
    if (isLearner) {
      if (
        ctx.writable &&
        (status === "WAITING_FOR_EXPERT" || status === "NEEDS_REVISION") &&
        learnerRows.length < MAX_LEARNER_VERSIONS_PER_THREAD
      ) {
        actions.push("upload_version");
      }
      if (
        ctx.writable &&
        latest.uploadedByRole === "CONSULTEE" &&
        latest.reviewStatus === "PENDING"
      ) {
        actions.push("withdraw_latest");
      }
      if (!removal && status !== "WAITING_FOR_EXPERT") {
        actions.push("request_removal");
      }
    } else if (
      ctx.writable &&
      OPEN_STATUSES.has(status) &&
      !latestLearner?.isStorageMissing
    ) {
      actions.push("review");
    }
  } else if (!isLearner && ctx.writable) {
    actions.push("delete_shared");
  }

  const bannerKind: ThreadBannerKind = removal ? "REMOVAL_REQUESTED" : status;
  const reviewed = latestLearner?.reviewedAt ?? null;
  const since =
    bannerKind === "REMOVAL_REQUESTED"
      ? root.removalRequestedAt!
      : status === "WAITING_FOR_EXPERT" || status === "SHARED"
        ? (latestLearner ?? root).uploadedAt
        : (reviewed ?? latest.uploadedAt);
  return {
    rootId,
    title: root.originalName,
    kind,
    status,
    banner: {
      kind: bannerKind,
      since: since.toISOString(),
      versionNo: (latestLearner ?? root).versionNo,
    },
    removal,
    learnerVersions: {
      used: learnerRows.length,
      max: MAX_LEARNER_VERSIONS_PER_THREAD,
    },
    allowedActions: actions,
    reviewTargetId:
      kind === "submission" && latestLearner && !latestLearner.isStorageMissing
        ? latestLearner.id
        : null,
    latestVersionNo: latest.versionNo,
    updatedAt: latest.uploadedAt.toISOString(),
    versions: versions.map((v) => {
      const byLearner = v.uploadedByRole === "CONSULTEE";
      return {
        id: v.id,
        versionNo: v.versionNo,
        by: byLearner ? "learner" : "expert",
        label: versionLabel(v, rootId, ctx.viewerRole),
        originalName: v.originalName,
        mimeType: v.mimeType,
        fileSize: v.fileSize,
        uploadedAt: v.uploadedAt.toISOString(),
        note: v.description?.trim() || null,
        feedback: byLearner ? v.reviewNotes?.trim() || null : null,
        reviewStatus: byLearner ? v.reviewStatus : null,
        reviewedAt: byLearner ? iso(v.reviewedAt) : null,
        superseded: byLearner && v.id !== latestLearner?.id,
        storageMissing: v.isStorageMissing,
      };
    }),
  };
}

/** The one thread order for the workspace and the Library: needs-you first, then newest, then id. */
export function compareThreadOrder(
  a: { needsYou: boolean; updatedAt: string; id: string },
  b: { needsYou: boolean; updatedAt: string; id: string },
): number {
  if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Groups live rows by `COALESCE(rootDocumentId, id)` in the shared thread order for the viewer. */
export function buildThreadViews(
  rows: readonly ThreadRow[],
  ctx: ThreadViewContext,
): ThreadView[] {
  const byRoot = new Map<string, ThreadRow[]>();
  for (const row of rows) {
    const rootId = row.rootDocumentId ?? row.id;
    const list = byRoot.get(rootId);
    if (list) list.push(row);
    else byRoot.set(rootId, [row]);
  }
  const key = (t: ThreadView) => ({
    needsYou: threadNeedsViewer(t, ctx.viewerRole),
    updatedAt: t.updatedAt,
    id: t.rootId,
  });
  return [...byRoot.entries()]
    .map(([rootId, list]) => buildThread(rootId, list, ctx))
    .sort((a, b) => compareThreadOrder(key(a), key(b)));
}

/** Whose move it is, from the viewer's side; drives the "Your turn" filter and counts. */
export function threadNeedsViewer(
  thread: Pick<ThreadView, "status" | "kind" | "removal">,
  viewerRole: DocumentPartyRole,
): boolean {
  if (thread.kind === "shared" || thread.removal) return false;
  return viewerRole === "expert"
    ? thread.status === "WAITING_FOR_EXPERT" || thread.status === "IN_REVIEW"
    : thread.status === "NEEDS_REVISION";
}
