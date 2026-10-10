/**
 * #1527 — the Library list contract (Documents · Recordings), shared by the
 * server read and the client browser. Pure: no prisma, so client components
 * import it. One page is a page of SESSIONS (appointments), each carrying its
 * files, so the grouped and the flat view page the same way.
 */

import type {
  DocumentReviewStatus,
  MemberRole,
  MemberStatus,
  RecordingStatus,
} from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";

export type LibraryScope = "mine" | "everyone";

export const LIBRARY_KINDS = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  CONSULTATION: "1:1",
  SUBSCRIPTION: "Subscription",
  WEBINAR: "Webinar",
  CLASS: "Class",
};

/** Relative to the viewer: "mine" is what they uploaded on their side. */
export const DOCUMENT_SOURCES = [
  "materials",
  "mine",
  "expert",
  "learner",
] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const DOCUMENT_SOURCE_LABEL: Record<DocumentSource, string> = {
  materials: "Materials",
  mine: "Mine",
  expert: "From expert",
  learner: "From learner",
};

/** Sessions per page; each carries its own bounded file list. */
export const LIBRARY_PAGE_SIZE = 10;

export interface LibraryQuery {
  q: string;
  kind: LibraryKind | null;
  /** Inclusive calendar days, `YYYY-MM-DD` (UTC). */
  from: string | null;
  to: string | null;
  source: DocumentSource | null;
  page: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(list: readonly T[], raw: string | null) {
  return list.includes(raw as T) ? (raw as T) : null;
}

/** Lenient parse: an unknown value is dropped, never a 400. */
export function parseLibraryQuery(
  get: (key: string) => string | null,
): LibraryQuery {
  const day = (raw: string | null) =>
    raw && DAY.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : null;
  const page = Number.parseInt(get("page") ?? "1", 10);
  return {
    q: (get("q") ?? "").trim().slice(0, 100),
    kind: oneOf(LIBRARY_KINDS, get("kind")),
    from: day(get("from")),
    to: day(get("to")),
    source: oneOf(DOCUMENT_SOURCES, get("source")),
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}

/**
 * Mine for any ACTIVE or SUSPENDED member (the caller floors membership);
 * Everyone is the oversight view — ACTIVE with `operations.read`. Null = 403.
 */
export function libraryScopeFor(
  requested: string | null,
  member: { role: MemberRole; status: MemberStatus },
): LibraryScope | null {
  if (requested !== "everyone") return "mine";
  return member.status === "ACTIVE" &&
    hasOrgPermission(member.role, "operations.read")
    ? "everyone"
    : null;
}

/** Plan materials and "Mine" only mean something on the viewer's own sessions. */
export function documentSourcesFor(scope: LibraryScope): DocumentSource[] {
  return scope === "mine" ? [...DOCUMENT_SOURCES] : ["expert", "learner"];
}

export interface LibrarySession {
  appointmentId: string;
  kind: LibraryKind;
  title: string;
  startsAt: string | null;
  expertName: string | null;
}

export interface LibraryDocument {
  id: string;
  name: string;
  source: DocumentSource;
  /** Null on the Everyone view: metadata only (ADR 20). */
  url: string | null;
  uploadedAt: string;
  /** A learner upload's review outcome; null for materials and responses. */
  reviewStatus: DocumentReviewStatus | null;
}

export interface LibraryRecording {
  id: string;
  title: string;
  recordedAt: string;
  durationInMinutes: number;
  status: RecordingStatus;
  /** False on the Everyone view or while the media isn't playable; the URL is fetched on play. */
  playable: boolean;
}

export interface LibraryGroup<F> {
  session: LibrarySession;
  files: F[];
}

export interface LibraryPage<F> {
  groups: LibraryGroup<F>[];
  /** Sessions matching the filters, not files. */
  total: number;
  page: number;
  pageSize: number;
}

/** The flat view: every file of the page's sessions, tagged with its session. */
export function flattenLibrary<F extends { id: string }>(
  groups: LibraryGroup<F>[],
): (F & { session: LibrarySession })[] {
  return groups.flatMap((g) =>
    g.files.map((file) => ({ ...file, session: g.session })),
  );
}
