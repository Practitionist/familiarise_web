/**
 * Builds the Documents library's thread rows from server-built thread views:
 * the root's title, who started it, the latest version and every version,
 * newest first. Pure and client-safe.
 */

import type { DocumentPartyRole } from "@/lib/documents/document-party";
import {
  threadNeedsViewer,
  type ThreadView,
} from "@/lib/documents/thread-view";
import { getDocumentViewerUrl } from "@/lib/documents/urls";
import type {
  LibraryDocument,
  LibraryThreadVersion,
  LibraryVersionStatus,
} from "./library-query";

const NOTE_EXCERPT_CHARS = 140;

const REVIEW_STATUSES: ReadonlySet<string> = new Set<LibraryVersionStatus>([
  "PENDING",
  "IN_REVIEW",
  "NEEDS_REVISION",
  "APPROVED",
  "REJECTED",
]);

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function excerpt(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= NOTE_EXCERPT_CHARS) return flat;
  return `${flat.slice(0, NOTE_EXCERPT_CHARS - 1).trimEnd()}…`;
}

function versionStatus(
  version: ThreadView["versions"][number],
): LibraryVersionStatus | null {
  if (version.by === "expert") return null;
  if (version.superseded) return "SUPERSEDED";
  const status = version.reviewStatus ?? "PENDING";
  return REVIEW_STATUSES.has(status)
    ? (status as LibraryVersionStatus)
    : "PENDING";
}

export function toLibraryThread(
  thread: ThreadView,
  ctx: {
    viewerRole: DocumentPartyRole;
    learnerName: string;
    expertName: string;
  },
): LibraryDocument {
  const nameOf = (by: DocumentPartyRole) =>
    by === ctx.viewerRole
      ? "You"
      : firstName(by === "learner" ? ctx.learnerName : ctx.expertName);
  const starter: DocumentPartyRole =
    thread.kind === "submission" ? "learner" : "expert";
  const versions: LibraryThreadVersion[] = [...thread.versions]
    .sort((a, b) => b.versionNo - a.versionNo)
    .map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      originalName: v.originalName,
      uploadedByRole: v.by === "learner" ? "CONSULTEE" : "CONSULTANT",
      uploadedBy: nameOf(v.by),
      isExpertReply: v.label === "Expert reply",
      reviewStatus: versionStatus(v),
      reviewNotesExcerpt: excerpt(v.feedback),
      uploadedAt: v.uploadedAt,
      url: getDocumentViewerUrl(v.id),
    }));
  const latest = versions[0]!;
  return {
    id: thread.rootId,
    title: thread.title,
    source: starter === ctx.viewerRole ? "mine" : starter,
    startedBy: nameOf(starter),
    status: thread.status,
    needsYou: threadNeedsViewer(thread, ctx.viewerRole),
    removalRequested: thread.removal !== null,
    latest: {
      id: latest.id,
      versionNo: latest.versionNo,
      originalName: latest.originalName,
      uploadedAt: latest.uploadedAt,
      url: latest.url,
    },
    versionCount: versions.length,
    versions,
  };
}
