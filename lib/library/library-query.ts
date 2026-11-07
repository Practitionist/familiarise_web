/**
 * The Library list contract (Documents · Recordings) shared by the server
 * reads and the client browser. Pure: no prisma, so client components import
 * it. One page is a page of sessions (appointments), each carrying its rows,
 * so the grouped and the flat view page the same way.
 */

import type { MemberRole, MemberStatus } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";
import {
  compareThreadOrder,
  type ThreadStatus,
} from "@/lib/documents/thread-view";
import type { RetentionLabelDTO } from "@/lib/stream/recording-slots";
import type { Tone } from "@/lib/ui/tone";

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
  CONSULTATION: "Consultation",
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

/** Who started a thread, relative to the viewer; "materials" selects plan materials instead. */
export const DOCUMENT_SOURCES = [
  "materials",
  "mine",
  "expert",
  "learner",
] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];
export type ThreadSource = Exclude<DocumentSource, "materials">;

export const DOCUMENT_SOURCE_LABEL: Record<DocumentSource, string> = {
  materials: "Plan materials only",
  mine: "You",
  expert: "Expert",
  learner: "Learner",
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

/** URL filters that change which Library page is read (`view` and `scope` do not). */
export const LIBRARY_READ_FILTERS = [
  "kind",
  "from",
  "to",
  "source",
  "person",
  "status",
] as const;

/** The read's query string; the client's query key ends with it, so a server seed builds it here too. */
export function libraryQueryString(
  fixedParams: Record<string, string> | undefined,
  state: {
    q: string;
    page: number;
    filters: Partial<
      Record<(typeof LIBRARY_READ_FILTERS)[number], string | null>
    >;
  },
): string {
  const search = new URLSearchParams(fixedParams);
  if (state.q) search.set("q", state.q);
  if (state.page > 1) search.set("page", String(state.page));
  for (const key of LIBRARY_READ_FILTERS) {
    const value = state.filters[key];
    if (value) search.set(key, value);
  }
  return search.toString();
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

/**
 * The Everyone view is counts only, so no free text, person or source may
 * narrow it: a match on a file name, a recording title or a participant would
 * confirm content the view never shows. Kind, dates and status stay: the rows
 * and counts display them.
 */
export function everyoneLibraryQuery(query: LibraryQuery): LibraryQuery {
  return { ...query, q: "", person: null, source: null };
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
  /** The first live session, or a subscription's start. */
  startsAt: string | null;
  /** Live sessions on the booking, when known. */
  sessionCount: number | null;
  expertName: string | null;
  /** The other person on the booking, from the viewer's side. */
  counterpartName: string | null;
}

/** A version's review state; earlier learner versions read SUPERSEDED. */
export type LibraryVersionStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "NEEDS_REVISION"
  | "APPROVED"
  | "REJECTED"
  | "SUPERSEDED";

export interface LibraryThreadVersion {
  id: string;
  versionNo: number;
  originalName: string;
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  /** "You" or the uploader's first name. */
  uploadedBy: string;
  isExpertReply: boolean;
  /** Learner versions only. */
  reviewStatus: LibraryVersionStatus | null;
  reviewNotesExcerpt: string | null;
  uploadedAt: string;
  /** Opens this version in a new tab. */
  url: string;
}

/** One document thread: the root's title, the latest version and every version, newest first. */
export interface LibraryDocument {
  /** The thread root. */
  id: string;
  title: string;
  source: ThreadSource;
  /** "You" or the other person's first name. */
  startedBy: string;
  status: ThreadStatus;
  needsYou: boolean;
  /** Worded like the status filter that returns this row. */
  chip: { label: string; tone: Tone };
  removalRequested: boolean;
  latest: {
    id: string;
    versionNo: number;
    originalName: string;
    uploadedAt: string;
    url: string;
  };
  versionCount: number;
  versions: LibraryThreadVersion[];
}

/** A plan material on the booking's plan: not a thread, so no status. */
export interface LibraryMaterial {
  id: string;
  title: string;
  fileType: string;
  fileSize: number;
  url: string;
}

export interface LibraryRecordingPart {
  /** The recording id; the playback URL is fetched on play. */
  id: string;
  title: string;
  /** "Part 1 of 2", or null for a single recording. */
  partLabel: string | null;
  recordedAt: string;
  durationInMinutes: number;
  keptUntil: RetentionLabelDTO | null;
}

/** What a session row says; `recorded` carries no badge. */
export type RecordingRowState =
  | "recorded"
  | "catch_up"
  | "removed"
  | "declined"
  | "not_recorded"
  | "preparing"
  | "expired"
  | "upcoming"
  | "before_you_joined"
  | "cancelled";

export interface LibraryRemovedPart {
  partNo: number;
  partCount: number;
  removedAt: string | null;
  /** Who removed it: the expert, the organisation or Familiarise support, by name. */
  removedBy: string;
}

/** One session of the viewer's own booking, in order, whatever its state. */
export interface LibraryRecording {
  /** `<appointmentId>:slot-<ordinal>`, or the recording id for a purchased replay. */
  id: string;
  title: string;
  /** The session number on the viewer's booking; null for a purchased replay. */
  slotOrdinal: number | null;
  /** The viewer's own session (a replay's recording date). */
  sessionAt: string;
  state: RecordingRowState;
  durationInMinutes: number;
  /** A catch-up's source: another batch (class) or run (webinar), and when it was recorded. */
  catchUp: { from: "batch" | "run"; recordedAt: string } | null;
  /** When it was first removed, and every distinct remover by name. */
  removed: { at: string | null; by: string[] } | null;
  /** A 1:1 session someone declined to record: their name, when known. */
  declinedBy: string | null;
  keptUntil: RetentionLabelDTO | null;
  parts: LibraryRecordingPart[];
  removedParts: LibraryRemovedPart[];
}

/** How long a booking's recordings are kept, said once in its header. */
export type LibraryRetention =
  | RetentionLabelDTO
  | { kind: "SUBSCRIPTION_ACTIVE" }
  | { kind: "CLASS_RUNNING" };

/** A recordings card's header facts and the upcoming sessions it leaves out. */
export interface LibraryTimeline {
  /** Hosts read neutral wording ("Batch", "the subscription"). */
  viewerRole: "host" | "learner";
  sessionCount: number;
  firstSessionAt: string | null;
  lastSessionAt: string | null;
  retention: LibraryRetention | null;
  moreUpcoming: number;
}

/** The Everyone view: what happened, never what was shared. */
export interface LibrarySummary {
  documents?: { threads: number; open: number; done: number };
  recordings?: { count: number; minutes: number };
}

export interface LibraryGroup<F> {
  session: LibrarySession;
  files: F[];
  /** Documents only: the plan's materials, apart from the threads. */
  materials?: LibraryMaterial[];
  /** Recordings only: the card header and the upcoming sessions left out. */
  timeline?: LibraryTimeline;
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

/** The shared thread order, read off a Library row. */
export function compareLibraryThreads(
  a: Pick<LibraryDocument, "id" | "needsYou" | "latest">,
  b: Pick<LibraryDocument, "id" | "needsYou" | "latest">,
): number {
  const key = (t: typeof a) => ({
    needsYou: t.needsYou,
    updatedAt: t.latest.uploadedAt,
    id: t.id,
  });
  return compareThreadOrder(key(a), key(b));
}
