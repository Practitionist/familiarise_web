/**
 * The Library list contract (Documents · Recordings) shared by the server
 * reads and the client browser. Pure: no prisma, so client components import
 * it. One page is a page of sessions (appointments), each carrying its rows,
 * so the grouped and the flat view page the same way.
 */

import type { MemberRole, MemberStatus, RecordingStatus } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";
import type { ThreadStatus } from "@/lib/documents/thread-view";
import type { RetentionLabelDTO } from "@/lib/stream/recording-slots";

export type LibraryScope = "mine" | "everyone";

export const LIBRARY_KINDS = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "TRIAL",
  "WEBINAR",
  "CLASS",
] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  CONSULTATION: "1:1",
  SUBSCRIPTION: "Subscription",
  TRIAL: "Trial",
  WEBINAR: "Webinar",
  CLASS: "Class",
};

/** Document thread filters, relative to the viewer. */
export const LIBRARY_DOC_STATUSES = [
  "your-turn",
  "waiting",
  "done",
  "shared",
] as const;
export type LibraryDocStatus = (typeof LIBRARY_DOC_STATUSES)[number];

export const LIBRARY_DOC_STATUS_LABEL: Record<LibraryDocStatus, string> = {
  "your-turn": "Your turn",
  waiting: "Waiting for the other side",
  done: "Done",
  shared: "Shared files",
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
  /** The other person on the booking (user id). */
  person: string | null;
  status: LibraryDocStatus | null;
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
    person: /^[\w-]{1,64}$/.test(get("person") ?? "") ? get("person") : null,
    status: oneOf(LIBRARY_DOC_STATUSES, get("status")),
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

/** The Everyone view is counts only, so it offers no source filter. */
export function documentSourcesFor(
  scope: LibraryScope,
): DocumentSource[] | undefined {
  return scope === "mine" ? [...DOCUMENT_SOURCES] : undefined;
}

export interface LibrarySession {
  appointmentId: string;
  kind: LibraryKind;
  title: string;
  startsAt: string | null;
  expertName: string | null;
  /** The other person on the booking, from the viewer's side. */
  counterpartName: string | null;
}

export interface LibraryDocument {
  /** The thread root, or the material id. */
  id: string;
  name: string;
  source: DocumentSource;
  /** Opens the latest version (or the material) in a new tab. */
  url: string | null;
  uploadedAt: string;
  /** The thread's status; null for plan materials. */
  status: ThreadStatus | null;
  versionNo: number | null;
  needsYou: boolean;
  removalRequested: boolean;
}

export interface LibraryRecording {
  id: string;
  title: string;
  recordedAt: string;
  durationInMinutes: number;
  status: RecordingStatus;
  /** False for a notice row; the playback URL is fetched on play. */
  playable: boolean;
  /** "Session 3 · Part 1 of 2". */
  sessionLabel: string | null;
  /** The run or batch a catch-up comes from. */
  catchUpFrom: string | null;
  keptUntil: RetentionLabelDTO | null;
  slotOrdinal: number | null;
  /** Why a session has nothing to play ("Removed by the expert on 5 Oct"). */
  notice: string | null;
}

/** The Everyone view: what happened, never what was shared. */
export interface LibrarySummary {
  documents?: { threads: number; open: number; done: number };
  recordings?: { count: number; minutes: number };
}

export interface LibraryGroup<F> {
  session: LibrarySession;
  files: F[];
  summary?: LibrarySummary;
}

export interface LibraryPage<F> {
  groups: LibraryGroup<F>[];
  /** Sessions matching the filters, not files. */
  total: number;
  page: number;
  pageSize: number;
  facets?: { people: { id: string; name: string }[] };
  /** Recordings only: replays the viewer bought, outside their own bookings. */
  purchased?: F[];
}

/** The flat view: every file of the page's sessions, tagged with its session. */
export function flattenLibrary<F extends { id: string }>(
  groups: LibraryGroup<F>[],
): (F & { session: LibrarySession })[] {
  return groups.flatMap((g) =>
    g.files.map((file) => ({ ...file, session: g.session })),
  );
}
