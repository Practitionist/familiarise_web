import "server-only";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  documentBookingSelect,
  documentPartyWhere,
  type DocumentBookingRow,
  documentWriteRefusal,
  partyRoleOf,
  toDocumentBooking,
  type DocumentPartyRole,
} from "@/lib/documents/document-party";
import {
  buildThreadViews,
  threadNeedsViewer,
  threadRowSelect,
  type ThreadView,
} from "@/lib/documents/thread-view";
import { fileTypeLabel } from "@/lib/documents/file-policy";
import { getMaterialViewerUrl } from "@/lib/documents/urls";
import { materialReaderWhere } from "@/lib/plans/material-access";
import { toLibraryThread } from "@/lib/library/document-threads";
import {
  LIBRARY_PAGE_SIZE,
  compareLibraryThreads,
  type LibraryDocStatus,
  type LibraryDocument,
  type LibraryGroup,
  type LibraryKind,
  type LibraryMaterial,
  type LibraryPage,
  type LibraryQuery,
  type LibrarySession,
} from "@/lib/library/library-query";

/**
 * The Documents library read, for the personal trees and the org tree. A page
 * is a page of bookings, read in one query; each carries its threads with
 * every version and, apart, the plan materials the viewer may open. The org
 * Everyone view returns counts only.
 */

export type LibraryOwner =
  | { kind: "personal"; side: DocumentPartyRole }
  | { kind: "org"; orgId: string; everyone: boolean };

const FILES_PER_SESSION = 50;
const PEOPLE_FACET_CAP = 100;
const DOCUMENT_KINDS = ["CONSULTATION", "SUBSCRIPTION", "TRIAL"] as const;

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

function learnerArms(userId: string): Prisma.AppointmentWhereInput[] {
  return [
    { consultation: { requestedBy: { userId } } },
    { subscription: { requestedBy: { userId } } },
    { trial: { consulteeProfile: { userId } } },
  ];
}

function expertArms(userId: string): Prisma.AppointmentWhereInput[] {
  return [
    { consultation: { consultationPlan: { consultantProfile: { userId } } } },
    { subscription: { subscriptionPlan: { consultantProfile: { userId } } } },
    { trial: { consultantProfile: { userId } } },
  ];
}

function scopeWhere(
  userId: string,
  owner: LibraryOwner,
): Prisma.AppointmentWhereInput {
  if (owner.kind === "personal") {
    return {
      organizationId: null,
      deletedAt: null,
      OR: owner.side === "learner" ? learnerArms(userId) : expertArms(userId),
    };
  }
  if (owner.everyone) {
    return {
      organizationId: owner.orgId,
      deletedAt: null,
      appointmentType: { in: [...DOCUMENT_KINDS] },
    };
  }
  return { organizationId: owner.orgId, ...documentPartyWhere(userId) };
}

/** Bookings where `person` is the other side. */
function personWhere(
  person: string,
  owner: LibraryOwner,
): Prisma.AppointmentWhereInput {
  const arms =
    owner.kind === "personal"
      ? owner.side === "learner"
        ? expertArms(person)
        : learnerArms(person)
      : [...learnerArms(person), ...expertArms(person)];
  return { OR: arms };
}

const STATUS_PREFILTER: Record<
  LibraryDocStatus,
  (role: DocumentPartyRole) => Prisma.AppointmentDocumentWhereInput
> = {
  "your-turn": (role) => ({
    uploadedByRole: "CONSULTEE",
    reviewStatus: {
      in: role === "expert" ? ["PENDING", "IN_REVIEW"] : ["NEEDS_REVISION"],
    },
  }),
  waiting: (role) => ({
    uploadedByRole: "CONSULTEE",
    reviewStatus: {
      in: role === "expert" ? ["NEEDS_REVISION"] : ["PENDING", "IN_REVIEW"],
    },
  }),
  done: () => ({
    uploadedByRole: "CONSULTEE",
    reviewStatus: { in: ["APPROVED", "REJECTED"] },
  }),
  shared: () => ({ uploadedByRole: "CONSULTANT", rootDocumentId: null }),
};

function threadMatches(
  thread: ThreadView,
  status: LibraryDocStatus,
  role: DocumentPartyRole,
): boolean {
  if (status === "shared") return thread.kind === "shared";
  if (thread.kind === "shared") return false;
  const done = thread.status === "APPROVED" || thread.status === "NOT_ACCEPTED";
  if (status === "done") return done;
  const mine = threadNeedsViewer(thread, role);
  return status === "your-turn" ? mine : !done && !mine;
}

function sessionsWhere(
  userId: string,
  owner: LibraryOwner,
  query: LibraryQuery,
  role: DocumentPartyRole,
  plans: ReadablePlans | null,
): Prisma.AppointmentWhereInput {
  const documentFilter: Prisma.AppointmentDocumentWhereInput = {
    deletedAt: null,
    ...(query.status ? STATUS_PREFILTER[query.status](role) : {}),
    ...(query.q ? { OR: [{ originalName: contains(query.q) }] } : {}),
  };
  const hasFiles: Prisma.AppointmentWhereInput[] = [];
  if (query.source !== "materials") {
    hasFiles.push({ documents: { some: documentFilter } });
  }
  if (plans) {
    hasFiles.push(
      { consultation: { consultationPlanId: { in: plans.consultation } } },
      { subscription: { subscriptionPlanId: { in: plans.subscription } } },
    );
  }

  const and: Prisma.AppointmentWhereInput[] = [
    scopeWhere(userId, owner),
    { OR: hasFiles },
  ];
  if (query.kind) and.push({ appointmentType: query.kind });
  if (query.person) and.push(personWhere(query.person, owner));
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
  return { AND: and };
}

function firstStart(
  sessions: { startsAt: Date }[],
  fallback: Date | null,
): string | null {
  const times = sessions.map((s) => s.startsAt.getTime());
  if (times.length > 0) return new Date(Math.min(...times)).toISOString();
  return fallback?.toISOString() ?? null;
}

interface ReadablePlans {
  consultation: string[];
  subscription: string[];
}

/** Plans with a material the viewer may open (and matching `q`), resolved once so later filters are id lists. */
async function readablePlans(
  userId: string,
  q: string,
): Promise<ReadablePlans> {
  const rows = await prisma.planMaterial.findMany({
    where: {
      AND: [
        materialReaderWhere(userId),
        {
          OR: [
            { consultationPlanId: { not: null } },
            { subscriptionPlanId: { not: null } },
          ],
        },
        ...(q ? [{ originalName: contains(q) }] : []),
      ],
    },
    distinct: ["consultationPlanId", "subscriptionPlanId"],
    select: { consultationPlanId: true, subscriptionPlanId: true },
  });
  return {
    consultation: [...new Set(rows.flatMap((r) => r.consultationPlanId ?? []))],
    subscription: [...new Set(rows.flatMap((r) => r.subscriptionPlanId ?? []))],
  };
}

/** Users on the other side of a set of bookings, as the expert or the learner. */
function counterpartWhere(
  side: "expert" | "learner",
  bookings: Prisma.AppointmentWhereInput,
): Prisma.UserWhereInput {
  const on = { appointment: { is: bookings } };
  return side === "expert"
    ? {
        consultantProfile: {
          OR: [
            { consultationPlans: { some: { consultations: { some: on } } } },
            { subscriptionPlans: { some: { subscriptions: { some: on } } } },
            { trials: { some: on } },
          ],
        },
      }
    : {
        consulteeProfile: {
          OR: [
            { consultationRequests: { some: on } },
            { subscriptionRequests: { some: on } },
            { trials: { some: on } },
          ],
        },
      };
}

/** People on the other side of the viewer's bookings in scope, for the person filter. */
async function peopleFacet(
  userId: string,
  owner: LibraryOwner,
): Promise<{ id: string; name: string }[]> {
  const withFiles = { documents: { some: {} } };
  const arms: Prisma.UserWhereInput[] =
    owner.kind === "personal"
      ? [
          counterpartWhere(owner.side === "learner" ? "expert" : "learner", {
            ...scopeWhere(userId, owner),
            ...withFiles,
          }),
        ]
      : (["expert", "learner"] as const).map((side) =>
          counterpartWhere(side, {
            organizationId: owner.orgId,
            deletedAt: null,
            ...withFiles,
            OR: side === "expert" ? learnerArms(userId) : expertArms(userId),
          }),
        );
  const users = await prisma.user.findMany({
    where: { OR: arms },
    orderBy: { name: "asc" },
    take: PEOPLE_FACET_CAP,
    select: { id: true, name: true },
  });
  return users.sort((a, b) => a.name.localeCompare(b.name));
}

/** The page's rows: booking facts by profile id, so names are one read for the page. */
const libraryBookingSelect = {
  id: true,
  appointmentType: true,
  organizationId: true,
  organization: { select: { name: true } },
  consultation: {
    select: {
      status: true,
      cancelledAt: true,
      updatedAt: true,
      requestedById: true,
      consultationPlanId: true,
      consultationPlan: { select: { title: true, consultantProfileId: true } },
    },
  },
  subscription: {
    select: {
      status: true,
      cancelledAt: true,
      updatedAt: true,
      schedulingPeriodStartsAt: true,
      schedulingPeriodEndsAt: true,
      requestedById: true,
      subscriptionPlanId: true,
      subscriptionPlan: { select: { title: true, consultantProfileId: true } },
    },
  },
  trial: {
    select: {
      status: true,
      updatedAt: true,
      consulteeProfileId: true,
      consultantProfileId: true,
      subscriptionPlan: { select: { title: true } },
    },
  },
  occurrences: documentBookingSelect.occurrences,
  statusHistory: documentBookingSelect.statusHistory,
  // Writes cap a booking's threads and versions, so every live version is read.
  documents: {
    where: { deletedAt: null },
    orderBy: { versionNo: "asc" },
    select: threadRowSelect,
  },
} satisfies Prisma.AppointmentSelect;

type LibraryBookingRow = Prisma.AppointmentGetPayload<{
  select: typeof libraryBookingSelect;
}>;

type ProfileRow = { id: string; userId: string; user: { name: string } };

/** Names and user ids of the page's parties, keyed by profile id. */
async function partiesOf(
  rows: LibraryBookingRow[],
): Promise<Map<string, ProfileRow>> {
  const experts = rows
    .flatMap((r) => [
      r.consultation?.consultationPlan.consultantProfileId ?? [],
      r.subscription?.subscriptionPlan.consultantProfileId ?? [],
      r.trial?.consultantProfileId ?? [],
    ])
    .flat();
  const learners = rows
    .flatMap((r) => [
      r.consultation?.requestedById ?? [],
      r.subscription?.requestedById ?? [],
      r.trial?.consulteeProfileId ?? [],
    ])
    .flat();
  const parties = new Map<string, ProfileRow>();
  if (experts.length + learners.length === 0) return parties;
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { consultantProfile: { id: { in: experts } } },
        { consulteeProfile: { id: { in: learners } } },
      ],
    },
    select: {
      id: true,
      name: true,
      consultantProfile: { select: { id: true } },
      consulteeProfile: { select: { id: true } },
    },
  });
  for (const user of users) {
    for (const profile of [user.consultantProfile, user.consulteeProfile]) {
      if (profile) {
        parties.set(profile.id, {
          id: profile.id,
          userId: user.id,
          user: { name: user.name },
        });
      }
    }
  }
  return parties;
}

/** The shared booking row for `toDocumentBooking`, or null when a party is missing. */
function toBookingRow(
  row: LibraryBookingRow,
  parties: Map<string, ProfileRow>,
): DocumentBookingRow | null {
  const party = (id: string | null | undefined) =>
    id ? (parties.get(id) ?? null) : null;
  const { consultation: c, subscription: s, trial: t } = row;
  const base = {
    id: row.id,
    organizationId: row.organizationId,
    organization: row.organization,
    occurrences: row.occurrences,
    statusHistory: row.statusHistory,
  };
  if (c) {
    const requestedBy = party(c.requestedById);
    const expert = party(c.consultationPlan.consultantProfileId);
    if (!requestedBy || !expert) return null;
    return {
      ...base,
      subscription: null,
      trial: null,
      consultation: {
        status: c.status,
        cancelledAt: c.cancelledAt,
        updatedAt: c.updatedAt,
        requestedBy,
        consultationPlan: {
          title: c.consultationPlan.title,
          consultantProfile: expert,
        },
      },
    };
  }
  if (s) {
    const requestedBy = party(s.requestedById);
    const expert = party(s.subscriptionPlan.consultantProfileId);
    if (!requestedBy || !expert) return null;
    return {
      ...base,
      consultation: null,
      trial: null,
      subscription: {
        status: s.status,
        cancelledAt: s.cancelledAt,
        updatedAt: s.updatedAt,
        schedulingPeriodEndsAt: s.schedulingPeriodEndsAt,
        requestedBy,
        subscriptionPlan: {
          title: s.subscriptionPlan.title,
          consultantProfile: expert,
        },
      },
    };
  }
  if (t) {
    const consulteeProfile = party(t.consulteeProfileId);
    const consultantProfile = party(t.consultantProfileId);
    if (!consulteeProfile || !consultantProfile) return null;
    return {
      ...base,
      consultation: null,
      subscription: null,
      trial: {
        status: t.status,
        updatedAt: t.updatedAt,
        consulteeProfile,
        consultantProfile,
        subscriptionPlan: t.subscriptionPlan,
      },
    };
  }
  return null;
}

export async function readDocumentLibrary(args: {
  userId: string;
  owner: LibraryOwner;
  query: LibraryQuery;
}): Promise<LibraryPage<LibraryDocument>> {
  const { userId, owner, query } = args;
  const everyone = owner.kind === "org" && owner.everyone;
  const pageRole: DocumentPartyRole =
    owner.kind === "personal" ? owner.side : "learner";
  const withMaterials =
    !everyone &&
    query.status === null &&
    (query.source === null || query.source === "materials");
  const plans = withMaterials ? await readablePlans(userId, query.q) : null;
  const where = sessionsWhere(userId, owner, query, pageRole, plans);

  const [total, rows, people] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      select: libraryBookingSelect,
      orderBy: { createdAt: "desc" },
      take: LIBRARY_PAGE_SIZE,
      skip: (query.page - 1) * LIBRARY_PAGE_SIZE,
    }),
    everyone ? Promise.resolve([]) : peopleFacet(userId, owner),
  ]);
  const parties = await partiesOf(rows);

  const pagePlans = {
    consultation: rows.flatMap((r) => r.consultation?.consultationPlanId ?? []),
    subscription: rows.flatMap((r) => r.subscription?.subscriptionPlanId ?? []),
  };
  const materials = plans
    ? await prisma.planMaterial.findMany({
        where: {
          OR: [
            {
              consultationPlanId: {
                in: pagePlans.consultation.filter((id) =>
                  plans.consultation.includes(id),
                ),
              },
            },
            {
              subscriptionPlanId: {
                in: pagePlans.subscription.filter((id) =>
                  plans.subscription.includes(id),
                ),
              },
            },
          ],
          ...(query.q ? { originalName: contains(query.q) } : {}),
        },
        orderBy: [{ order: "asc" }, { uploadedAt: "asc" }],
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          fileSize: true,
          consultationPlanId: true,
          subscriptionPlanId: true,
        },
      })
    : [];

  const groups = rows.flatMap((row): LibraryGroup<LibraryDocument>[] => {
    const bookingRow = toBookingRow(row, parties);
    const booking = bookingRow ? toDocumentBooking(bookingRow) : null;
    if (!booking) return [];
    const role = partyRoleOf(booking, userId) ?? pageRole;
    const session: LibrarySession = {
      appointmentId: row.id,
      kind: row.appointmentType as LibraryKind,
      title: booking.title,
      startsAt: firstStart(
        row.occurrences,
        row.subscription?.schedulingPeriodStartsAt ?? null,
      ),
      sessionCount: row.occurrences.length,
      expertName: booking.expert.name,
      counterpartName: everyone
        ? null
        : role === "learner"
          ? booking.expert.name
          : booking.learner.name,
    };
    const threads = buildThreadViews(row.documents, {
      viewerRole: role,
      writable: documentWriteRefusal(booking) === null,
    });

    if (everyone) {
      const done = threads.filter(
        (t) => t.status === "APPROVED" || t.status === "NOT_ACCEPTED",
      ).length;
      return [
        {
          session,
          files: [],
          summary: {
            documents: {
              threads: threads.length,
              done,
              open: threads.length - done,
            },
          },
        },
      ];
    }

    const groupMaterials: LibraryMaterial[] =
      query.source === null || query.source === "materials"
        ? materials
            .filter(
              (m) =>
                (m.consultationPlanId &&
                  m.consultationPlanId ===
                    row.consultation?.consultationPlanId) ||
                (m.subscriptionPlanId &&
                  m.subscriptionPlanId ===
                    row.subscription?.subscriptionPlanId),
            )
            .map((m) => ({
              id: m.id,
              title: m.originalName,
              fileType: fileTypeLabel(m),
              fileSize: m.fileSize,
              url: getMaterialViewerUrl(m.id),
            }))
        : [];

    const needle = query.q.toLowerCase();
    const files: LibraryDocument[] =
      query.source === "materials"
        ? []
        : threads
            .map((thread) =>
              toLibraryThread(thread, {
                viewerRole: role,
                learnerName: booking.learner.name,
                expertName: booking.expert.name,
              }),
            )
            .filter(
              (thread, i) =>
                (!query.source || query.source === thread.source) &&
                (!query.status ||
                  threadMatches(threads[i]!, query.status, role)) &&
                (!needle ||
                  booking.title.toLowerCase().includes(needle) ||
                  thread.versions.some((v) =>
                    v.originalName.toLowerCase().includes(needle),
                  )),
            )
            .sort(compareLibraryThreads)
            .slice(0, FILES_PER_SESSION);
    if (files.length === 0 && groupMaterials.length === 0) return [];
    return [{ session, files, materials: groupMaterials }];
  });

  return {
    groups,
    total,
    page: query.page,
    pageSize: LIBRARY_PAGE_SIZE,
    facets: { people },
  };
}
