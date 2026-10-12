import "server-only";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  documentBookingSelect,
  documentPartyWhere,
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
): Prisma.AppointmentWhereInput {
  const everyone = owner.kind === "org" && owner.everyone;
  const withMaterials =
    !everyone &&
    query.status === null &&
    (query.source === null || query.source === "materials");
  const documentFilter: Prisma.AppointmentDocumentWhereInput = {
    deletedAt: null,
    ...(query.status ? STATUS_PREFILTER[query.status](role) : {}),
    ...(query.q ? { OR: [{ originalName: contains(query.q) }] } : {}),
  };
  const hasFiles: Prisma.AppointmentWhereInput[] = [];
  if (query.source !== "materials") {
    hasFiles.push({ documents: { some: documentFilter } });
  }
  if (withMaterials) {
    const material = {
      ...materialReaderWhere(userId),
      ...(query.q ? { originalName: contains(query.q) } : {}),
    };
    hasFiles.push(
      { consultation: { consultationPlan: { materials: { some: material } } } },
      { subscription: { subscriptionPlan: { materials: { some: material } } } },
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

/** People on the other side of the viewer's bookings in scope, for the person filter. */
async function peopleFacet(
  userId: string,
  owner: LibraryOwner,
): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.appointment.findMany({
    where: { ...scopeWhere(userId, owner), documents: { some: {} } },
    select: documentBookingSelect,
    take: 500,
  });
  const people = new Map<string, string>();
  for (const row of rows) {
    const booking = toDocumentBooking(row);
    if (!booking) continue;
    const role = partyRoleOf(booking, userId);
    const other =
      role === "learner"
        ? booking.expert
        : role === "expert"
          ? booking.learner
          : null;
    if (other) people.set(other.userId, other.name);
    if (!role) {
      people.set(booking.learner.userId, booking.learner.name);
      people.set(booking.expert.userId, booking.expert.name);
    }
  }
  return [...people.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, PEOPLE_FACET_CAP);
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
  const where = sessionsWhere(userId, owner, query, pageRole);

  const [total, rows, people] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      select: {
        ...documentBookingSelect,
        appointmentType: true,
        createdAt: true,
        documents: {
          where: { deletedAt: null },
          orderBy: { versionNo: "asc" },
          take: FILES_PER_SESSION * 4,
          select: threadRowSelect,
        },
        consultation: {
          select: {
            ...documentBookingSelect.consultation.select,
            consultationPlanId: true,
          },
        },
        subscription: {
          select: {
            ...documentBookingSelect.subscription.select,
            subscriptionPlanId: true,
            schedulingPeriodStartsAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: LIBRARY_PAGE_SIZE,
      skip: (query.page - 1) * LIBRARY_PAGE_SIZE,
    }),
    everyone ? Promise.resolve([]) : peopleFacet(userId, owner),
  ]);

  const planIds = {
    consultation: rows
      .map((r) => r.consultation?.consultationPlanId)
      .filter((id): id is string => Boolean(id)),
    subscription: rows
      .map((r) => r.subscription?.subscriptionPlanId)
      .filter((id): id is string => Boolean(id)),
  };
  const materials =
    everyone ||
    query.status !== null ||
    (query.source && query.source !== "materials")
      ? []
      : await prisma.planMaterial.findMany({
          where: {
            AND: [
              materialReaderWhere(userId),
              {
                OR: [
                  { consultationPlanId: { in: planIds.consultation } },
                  { subscriptionPlanId: { in: planIds.subscription } },
                ],
              },
              ...(query.q ? [{ originalName: contains(query.q) }] : []),
            ],
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
        });

  const groups = rows.flatMap((row): LibraryGroup<LibraryDocument>[] => {
    const booking = toDocumentBooking(row);
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
