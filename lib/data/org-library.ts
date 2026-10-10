/**
 * #1527 — the org Library read (Documents · Recordings), one query per page.
 *
 * Mine is the caller's own org sessions — attended as a learner or seat
 * holder, or delivered as the expert (the Appointments `orgMember` arm). The
 * files carry their URLs, the same content the consultee Library shows for
 * personal sessions (ADR 19 keeps the two apart). Everyone is the oversight
 * view over every org session and stops at metadata (ADR 20): no file URL,
 * no media, no description, no transcript.
 *
 * Auth stays with the route: it resolves the scope via `libraryScopeFor`.
 */

import {
  RecordingStatus,
  type DocumentUploadRole,
  type Prisma,
} from "@prisma/client";

import prisma from "@/lib/prisma";
import { buildWhere as appointmentScopeWhere } from "@/lib/api/scope/list-appointments";
import { lateJoinRecordingAccess } from "@/lib/stream/late-join-recordings";
import {
  extractRecordings,
  visibleSessionRecordings,
} from "@/lib/stream/session-recordings";
import {
  LIBRARY_PAGE_SIZE,
  type DocumentSource,
  type LibraryDocument,
  type LibraryKind,
  type LibraryPage,
  type LibraryQuery,
  type LibraryRecording,
  type LibraryScope,
  type LibrarySession,
} from "@/lib/library/library-query";

/** DOC-1 (#694) — a closed booking's files are no longer served. */
const CLOSED_STATUSES = ["CANCELLED", "REJECTED", "EXPIRED"] as const;
// Per-session caps keep one page bounded (PG_POOL_MAX=1).
const FILES_PER_SESSION = 50;
const OCCURRENCES_PER_SESSION = 200;
const LIVE_RECORDING: Prisma.RecordingWhereInput = {
  status: { notIn: ["FAILED", "EXPIRED"] },
};
/** Statuses GET /api/stream/recordings/[id] can mint a playback URL for. */
const PLAYABLE_STATUSES: ReadonlySet<RecordingStatus> = new Set([
  RecordingStatus.READY,
  RecordingStatus.TRANSFERRING,
  RecordingStatus.AVAILABLE,
]);

export interface OrgLibraryArgs {
  orgId: string;
  userId: string;
  scope: LibraryScope;
  query: LibraryQuery;
}

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** Documents live on 1:1 bookings; their two parties read them. */
function oneToOneParty(
  uid: string,
  side: "booked" | "delivered",
): Prisma.AppointmentWhereInput[] {
  if (side === "booked") {
    return [
      { consultation: { requestedBy: { userId: uid } } },
      { subscription: { requestedBy: { userId: uid } } },
    ];
  }
  return [
    {
      consultation: {
        consultationPlan: { consultantProfile: { userId: uid } },
      },
    },
    {
      subscription: {
        subscriptionPlan: { consultantProfile: { userId: uid } },
      },
    },
  ];
}

function roleFrom(
  uid: string,
  role: DocumentUploadRole,
): Prisma.AppointmentDocumentWhereInput {
  // A learner upload is the booker's; a response is the deliverer's.
  const side = role === "CONSULTEE" ? "booked" : "delivered";
  return {
    uploadedByRole: role,
    appointment: { OR: oneToOneParty(uid, side) },
  };
}

/** Which uploaded files the caller sees, narrowed by the source filter. */
function documentWhere(
  args: OrgLibraryArgs,
): Prisma.AppointmentDocumentWhereInput {
  const { scope, userId: uid } = args;
  const source = args.query.source;
  const base: Prisma.AppointmentDocumentWhereInput = { deletedAt: null };
  if (scope === "everyone") {
    if (source === "expert") return { ...base, uploadedByRole: "CONSULTANT" };
    if (source === "learner") return { ...base, uploadedByRole: "CONSULTEE" };
    return base;
  }
  const bySource: Record<DocumentSource, Prisma.AppointmentDocumentWhereInput> =
    {
      materials: { id: { in: [] } },
      mine: { OR: [roleFrom(uid, "CONSULTEE"), roleFrom(uid, "CONSULTANT")] },
      expert: {
        uploadedByRole: "CONSULTANT",
        appointment: { OR: oneToOneParty(uid, "booked") },
      },
      learner: {
        uploadedByRole: "CONSULTEE",
        appointment: { OR: oneToOneParty(uid, "delivered") },
      },
    };
  if (source) return { ...base, ...bySource[source] };
  return {
    ...base,
    appointment: {
      OR: [...oneToOneParty(uid, "booked"), ...oneToOneParty(uid, "delivered")],
    },
  };
}

type PlanArm = "consultation" | "subscription" | "webinar" | "class";
const PLAN_ARMS: [PlanArm, string][] = [
  ["consultation", "consultationPlan"],
  ["subscription", "subscriptionPlan"],
  ["webinar", "webinarPlan"],
  ["class", "classPlan"],
];

/** `{ <arm>: { <plan>: where } }` for each of the four plan kinds. */
function onPlan(where: object): Prisma.AppointmentWhereInput[] {
  return PLAN_ARMS.map(
    ([arm, plan]) =>
      ({ [arm]: { [plan]: where } }) as Prisma.AppointmentWhereInput,
  );
}

function withMaterials(args: OrgLibraryArgs): boolean {
  const { source } = args.query;
  return args.scope === "mine" && (source === null || source === "materials");
}

/** The session holds at least one file this caller sees (optionally named `q`). */
function hasFile(
  args: OrgLibraryArgs,
  artifact: "documents" | "recordings",
  q: string | null,
): Prisma.AppointmentWhereInput {
  if (artifact === "recordings") {
    const recording = { ...LIVE_RECORDING, ...(q && { title: contains(q) }) };
    return {
      occurrences: { some: { meeting: { recordings: { some: recording } } } },
    };
  }
  const named = q
    ? { OR: [{ originalName: contains(q) }, { fileName: contains(q) }] }
    : {};
  const arms: Prisma.AppointmentWhereInput[] = [];
  if (args.query.source !== "materials") {
    arms.push({ documents: { some: { AND: [documentWhere(args), named] } } });
  }
  if (withMaterials(args)) {
    const material = q ? { originalName: contains(q) } : {};
    arms.push(...onPlan({ materials: { some: material } }));
  }
  return { OR: arms };
}

function sessionWhere(
  args: OrgLibraryArgs,
  artifact: "documents" | "recordings",
): Prisma.AppointmentWhereInput {
  const { orgId, userId, scope, query } = args;
  const and: Prisma.AppointmentWhereInput[] = [
    scope === "mine"
      ? appointmentScopeWhere({
          scope: { kind: "orgMember", orgId, userId },
          userId,
        })
      : { organizationId: orgId, deletedAt: null },
    hasFile(args, artifact, null),
  ];
  if (scope === "mine" && artifact === "documents") {
    and.push({
      NOT: {
        OR: [
          { consultation: { status: { in: [...CLOSED_STATUSES] } } },
          { subscription: { status: { in: [...CLOSED_STATUSES] } } },
        ],
      },
    });
  }
  if (query.kind) and.push({ appointmentType: query.kind });
  if (query.from || query.to) {
    const startsAt: Prisma.DateTimeFilter = {};
    if (query.from) startsAt.gte = new Date(`${query.from}T00:00:00Z`);
    if (query.to) {
      const end = new Date(`${query.to}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      startsAt.lt = end;
    }
    and.push({ occurrences: { some: { deletedAt: null, startsAt } } });
  }
  if (query.q) {
    and.push({
      OR: [
        ...onPlan({ title: contains(query.q) }),
        hasFile(args, artifact, query.q),
      ],
    });
  }
  return { AND: and };
}

const person = {
  select: { user: { select: { name: true } } },
} as const;

function planSelect(materials: boolean) {
  return {
    select: {
      title: true,
      consultantProfile: person,
      ...(materials && {
        materials: {
          select: {
            id: true,
            originalName: true,
            fileUrl: true,
            uploadedAt: true,
          },
          orderBy: { order: "asc" as const },
          take: FILES_PER_SESSION,
        },
      }),
    },
  };
}

function sessionSelect(materials: boolean) {
  const plan = planSelect(materials);
  return {
    id: true,
    appointmentType: true,
    consultation: {
      select: {
        consultationPlan: plan,
        requestedBy: { select: { userId: true } },
      },
    },
    subscription: {
      select: {
        subscriptionPlan: plan,
        requestedBy: { select: { userId: true } },
      },
    },
    webinar: { select: { webinarPlan: plan } },
    class: { select: { id: true, classPlanId: true, classPlan: plan } },
  } satisfies Prisma.AppointmentSelect;
}

interface PlanShape {
  title: string;
  consultantProfile: { user: { name: string | null } } | null;
  materials?: {
    id: string;
    originalName: string;
    fileUrl: string;
    uploadedAt: Date;
  }[];
}

interface SessionShape {
  id: string;
  appointmentType: string;
  consultation: {
    consultationPlan: PlanShape;
    requestedBy: { userId: string };
  } | null;
  subscription: {
    subscriptionPlan: PlanShape;
    requestedBy: { userId: string };
  } | null;
  webinar: { webinarPlan: PlanShape } | null;
  class: { id: string; classPlanId: string; classPlan: PlanShape } | null;
}

function planOf(s: SessionShape): PlanShape | null {
  return (
    s.consultation?.consultationPlan ??
    s.subscription?.subscriptionPlan ??
    s.webinar?.webinarPlan ??
    s.class?.classPlan ??
    null
  );
}

function toSession(s: SessionShape, startsAt: Date | null): LibrarySession {
  const plan = planOf(s);
  return {
    appointmentId: s.id,
    kind: s.appointmentType as LibraryKind,
    title: plan?.title ?? "Session",
    startsAt: startsAt?.toISOString() ?? null,
    expertName: plan?.consultantProfile?.user.name ?? null,
  };
}

/** With a search that misses the title, only the files it names stay. */
function keepNamed<F>(
  files: F[],
  session: LibrarySession,
  q: string,
  name: (f: F) => string,
): F[] {
  const needle = q.toLowerCase();
  if (!needle || session.title.toLowerCase().includes(needle)) return files;
  return files.filter((f) => name(f).toLowerCase().includes(needle));
}

function pageWindow(page: number) {
  return {
    orderBy: { createdAt: "desc" as const },
    take: LIBRARY_PAGE_SIZE,
    skip: (page - 1) * LIBRARY_PAGE_SIZE,
  };
}

export async function readOrgLibraryDocuments(
  args: OrgLibraryArgs,
): Promise<LibraryPage<LibraryDocument>> {
  const { scope, userId, query } = args;
  const mine = scope === "mine";
  const materials = withMaterials(args);
  const select = {
    ...sessionSelect(materials),
    occurrences: {
      where: { deletedAt: null },
      orderBy: { startsAt: "asc" as const },
      take: 1,
      select: { startsAt: true },
    },
    ...(query.source !== "materials" && {
      documents: {
        where: documentWhere(args),
        orderBy: { uploadedAt: "desc" as const },
        take: FILES_PER_SESSION,
        // ADR 20 — the Everyone view never selects the file itself.
        select: {
          id: true,
          originalName: true,
          uploadedByRole: true,
          reviewStatus: true,
          uploadedAt: true,
          ...(mine && { fileUrl: true }),
        },
      },
    }),
  } satisfies Prisma.AppointmentSelect;

  type Row = SessionShape & {
    occurrences: { startsAt: Date }[];
    documents?: {
      id: string;
      originalName: string;
      uploadedByRole: DocumentUploadRole;
      reviewStatus: LibraryDocument["reviewStatus"];
      uploadedAt: Date;
      fileUrl?: string;
    }[];
  };
  const where = sessionWhere(args, "documents");
  const [total, found] = await prisma.$transaction([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({ where, select, ...pageWindow(query.page) }),
  ]);
  const rows = found as unknown as Row[];

  const groups = rows.map((row) => {
    const session = toSession(row, row.occurrences[0]?.startsAt ?? null);
    const booker =
      row.consultation?.requestedBy.userId ??
      row.subscription?.requestedBy.userId;
    const viewerBooked = mine && booker === userId;
    const sourceOf = (role: DocumentUploadRole): DocumentSource => {
      if (role === "CONSULTEE") return viewerBooked ? "mine" : "learner";
      return mine && !viewerBooked ? "mine" : "expert";
    };
    const files: LibraryDocument[] = [
      ...(planOf(row)?.materials ?? []).map((m) => ({
        id: m.id,
        name: m.originalName,
        source: "materials" as const,
        url: m.fileUrl,
        uploadedAt: m.uploadedAt.toISOString(),
        reviewStatus: null,
      })),
      ...(row.documents ?? []).map((d) => ({
        id: d.id,
        name: d.originalName,
        source: sourceOf(d.uploadedByRole),
        url: d.fileUrl ?? null,
        uploadedAt: d.uploadedAt.toISOString(),
        reviewStatus: d.uploadedByRole === "CONSULTEE" ? d.reviewStatus : null,
      })),
    ];
    return {
      session,
      files: keepNamed(files, session, query.q, (f) => f.name),
    };
  });

  return { groups, total, page: query.page, pageSize: LIBRARY_PAGE_SIZE };
}

export async function readOrgLibraryRecordings(
  args: OrgLibraryArgs,
): Promise<LibraryPage<LibraryRecording>> {
  const { scope, userId, query } = args;
  const mine = scope === "mine";
  const select = {
    ...sessionSelect(false),
    occurrences: {
      where: { deletedAt: null },
      orderBy: { startsAt: "asc" as const },
      take: OCCURRENCES_PER_SESSION,
      select: {
        startsAt: true,
        meeting: {
          select: {
            recordings: {
              where: LIVE_RECORDING,
              orderBy: { recordedAt: "desc" as const },
              take: FILES_PER_SESSION,
              // ADR 20 — media fields only on the caller's own sessions.
              select: {
                id: true,
                title: true,
                durationInMinutes: true,
                recordedAt: true,
                status: true,
                ...(mine && { thumbnailUrl: true }),
              },
            },
          },
        },
      },
    },
  } satisfies Prisma.AppointmentSelect;

  type Recording = Omit<LibraryRecording, "recordedAt" | "playable"> & {
    recordedAt: Date;
    thumbnailUrl: string | null;
  };
  type Row = SessionShape & {
    occurrences: {
      startsAt: Date;
      meeting: { recordings: Recording[] } | null;
    }[];
  };
  const where = sessionWhere(args, "recordings");
  const [total, found] = await prisma.$transaction([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({ where, select, ...pageWindow(query.page) }),
  ]);
  const rows = found as unknown as Row[];

  // #1819 — only a Mine page with a class seat needs the late-join read.
  const lateJoin =
    mine && rows.some((r) => r.class)
      ? await lateJoinRecordingAccess(userId)
      : null;

  const groups = rows.map((row) => {
    const session = toSession(row, row.occurrences[0]?.startsAt ?? null);
    let recordings: LibraryRecording[];
    if (mine) {
      const lateJoinAccess =
        lateJoin && row.class
          ? {
              access: lateJoin,
              classId: row.class.id,
              classPlanId: row.class.classPlanId,
            }
          : undefined;
      recordings = extractRecordings([row], lateJoinAccess).map((r) => ({
        id: r.id,
        title: r.title,
        recordedAt: r.recordedAt.toISOString(),
        durationInMinutes: r.durationInMinutes,
        status: r.status,
        playable: PLAYABLE_STATUSES.has(r.status),
      }));
    } else {
      recordings = visibleSessionRecordings([row]).map((r) => ({
        id: r.id,
        title: r.title,
        recordedAt: r.recordedAt.toISOString(),
        durationInMinutes: r.durationInMinutes,
        status: r.status,
        playable: false,
      }));
    }
    return {
      session,
      files: keepNamed(recordings, session, query.q, (r) => r.title),
    };
  });

  // A late joiner's hidden sessions drop out of the page; `total` still
  // counts them (the rule runs on the rows, not in the count).
  return {
    groups: groups.filter((g) => g.files.length > 0),
    total,
    page: query.page,
    pageSize: LIBRARY_PAGE_SIZE,
  };
}
