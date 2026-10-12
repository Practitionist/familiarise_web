import "server-only";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  LIBRARY_PAGE_SIZE,
  type LibraryKind,
  type LibraryPage,
  type LibraryQuery,
  type LibraryRecording,
  type LibrarySession,
} from "@/lib/library/library-query";
import { partLabel, slotStateText } from "@/lib/stream/recording-copy";
import {
  PLAYABLE,
  learnerProfileId,
  loadRecordingViews,
  type LoadedRecordingView,
  type RecordingBookingView,
  type RecordingSlot,
} from "@/lib/stream/recording-slots";
import type { LibraryOwner } from "./document-library";

/**
 * The Recordings library read. Each booking is read with the same slot rule
 * as its Recording details page, so a row here always plays there: the
 * viewer's own sessions, parts and catch-up, never another run as a group.
 * The org Everyone view returns counts only.
 */

const ENTITLED_SEAT = ["CONFIRMED", "ATTENDED"] as const;
/** Whether a booking renders is decided in memory over at most this many newest candidates. */
const CANDIDATE_CAP = 200;
const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });
const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const day = (iso: string) => dayFormat.format(new Date(iso));

function learnerArms(userId: string): Prisma.AppointmentWhereInput[] {
  return [
    { consultation: { requestedBy: { userId } } },
    { subscription: { requestedBy: { userId } } },
    { trial: { consulteeProfile: { userId } } },
    {
      participants: {
        some: { userId, role: "CONSULTEE", status: { in: [...ENTITLED_SEAT] } },
      },
    },
  ];
}

function hostArms(userId: string): Prisma.AppointmentWhereInput[] {
  const owns = { consultantProfile: { userId } };
  const cohost = {
    collaborators: {
      some: {
        status: "ACCEPTED" as const,
        tier: "PRESENTER" as const,
        consultantProfile: { userId },
      },
    },
  };
  return [
    { consultation: { consultationPlan: owns } },
    { subscription: { subscriptionPlan: owns } },
    { trial: { consultantProfile: { userId } } },
    { webinar: { webinarPlan: { OR: [owns, cohost] } } },
    { class: { classPlan: { OR: [owns, cohost] } } },
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
      OR: owner.side === "learner" ? learnerArms(userId) : hostArms(userId),
    };
  }
  if (owner.everyone) return { organizationId: owner.orgId, deletedAt: null };
  return {
    organizationId: owner.orgId,
    deletedAt: null,
    OR: [...learnerArms(userId), ...hostArms(userId)],
  };
}

function personWhere(
  person: string,
  owner: LibraryOwner,
): Prisma.AppointmentWhereInput {
  if (owner.kind === "personal" && owner.side === "learner") {
    return { OR: hostArms(person) };
  }
  if (owner.kind === "personal") return { OR: learnerArms(person) };
  return { OR: [...learnerArms(person), ...hostArms(person)] };
}

function sessionsWhere(
  userId: string,
  owner: LibraryOwner,
  query: LibraryQuery,
): Prisma.AppointmentWhereInput {
  const learnerView = owner.kind === "personal" && owner.side === "learner";
  const recording = query.q ? { title: contains(query.q) } : {};
  const hasMedia: Prisma.AppointmentWhereInput[] = [
    { occurrences: { some: { meeting: { recordings: { some: recording } } } } },
  ];
  // A learner's ended run may catch up when its plan shares and some run has something playable.
  if (learnerView || (owner.kind === "org" && !owner.everyone)) {
    const now = new Date();
    const playableRun = {
      appointment: {
        deletedAt: null,
        occurrences: {
          some: {
            deletedAt: null,
            endsAt: { lt: now },
            completionStatus: {
              notIn: ["CANCELLED" as const, "RESCHEDULED" as const],
            },
            meeting: {
              recordings: { some: { status: { in: [...PLAYABLE] } } },
            },
          },
        },
      },
    };
    hasMedia.push({
      occurrences: { some: { deletedAt: null, endsAt: { lt: now } } },
      OR: [
        { class: { classPlan: { classes: { some: playableRun } } } },
        {
          webinar: {
            webinarPlan: {
              shareRecordingsWithAllAttendees: true,
              webinars: { some: playableRun },
            },
          },
        },
      ],
    });
  }
  const and: Prisma.AppointmentWhereInput[] = [
    scopeWhere(userId, owner),
    { OR: hasMedia },
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

const userName = { select: { user: { select: { name: true, id: true } } } };

const sessionSelect = {
  id: true,
  appointmentType: true,
  createdAt: true,
  consultation: {
    select: {
      requestedBy: userName,
      consultationPlan: {
        select: { title: true, consultantProfile: userName },
      },
    },
  },
  subscription: {
    select: {
      schedulingPeriodStartsAt: true,
      requestedBy: userName,
      subscriptionPlan: {
        select: { title: true, consultantProfile: userName },
      },
    },
  },
  trial: {
    select: {
      consulteeProfile: userName,
      consultantProfile: userName,
      subscriptionPlan: { select: { title: true } },
    },
  },
  webinar: {
    select: {
      webinarPlan: { select: { title: true, consultantProfile: userName } },
    },
  },
  class: {
    select: {
      classPlan: { select: { title: true, consultantProfile: userName } },
    },
  },
  occurrences: {
    where: { deletedAt: null },
    orderBy: { startsAt: "asc" as const },
    take: 1,
    select: { startsAt: true },
  },
} satisfies Prisma.AppointmentSelect;

type SessionRow = Prisma.AppointmentGetPayload<{
  select: typeof sessionSelect;
}>;

function toSession(row: SessionRow, learnerSide: boolean): LibrarySession {
  const plan =
    row.consultation?.consultationPlan ??
    row.subscription?.subscriptionPlan ??
    row.webinar?.webinarPlan ??
    row.class?.classPlan ??
    null;
  const title = plan?.title ?? row.trial?.subscriptionPlan.title ?? "Session";
  const expertName =
    plan?.consultantProfile?.user.name ??
    row.trial?.consultantProfile.user.name ??
    null;
  const learnerName =
    row.consultation?.requestedBy.user.name ??
    row.subscription?.requestedBy.user.name ??
    row.trial?.consulteeProfile.user.name ??
    null;
  return {
    appointmentId: row.id,
    kind: row.appointmentType as LibraryKind,
    title,
    startsAt:
      (
        row.occurrences[0]?.startsAt ??
        row.subscription?.schedulingPeriodStartsAt
      )?.toISOString() ?? null,
    sessionCount: null,
    expertName,
    counterpartName: learnerSide ? expertName : learnerName,
  };
}

async function everyoneSummaries(
  appointmentIds: string[],
): Promise<Map<string, { count: number; minutes: number }>> {
  const rows = await prisma.recording.findMany({
    where: {
      status: { notIn: ["FAILED", "EXPIRED"] },
      meeting: { occurrence: { appointmentId: { in: appointmentIds } } },
    },
    select: {
      durationInMinutes: true,
      meeting: { select: { occurrence: { select: { appointmentId: true } } } },
    },
  });
  const summaries = new Map<string, { count: number; minutes: number }>();
  for (const row of rows) {
    const id = row.meeting.occurrence.appointmentId;
    const sum = summaries.get(id) ?? { count: 0, minutes: 0 };
    sum.count += 1;
    sum.minutes += row.durationInMinutes;
    summaries.set(id, sum);
  }
  return summaries;
}

async function purchasedReplays(userId: string): Promise<LibraryRecording[]> {
  const rows = await prisma.recordingPurchase.findMany({
    where: {
      buyerId: userId,
      status: "SUCCEEDED",
      recording: { status: { notIn: ["FAILED", "EXPIRED"] } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      recording: {
        select: {
          id: true,
          title: true,
          listingTitle: true,
          recordedAt: true,
          durationInMinutes: true,
          status: true,
        },
      },
    },
  });
  return rows.map(({ recording: r }) => {
    const title = r.listingTitle ?? r.title;
    const recordedAt = r.recordedAt.toISOString();
    return {
      id: r.id,
      title,
      sessionLabel: null,
      recordedAt,
      durationInMinutes: r.durationInMinutes,
      catchUpFrom: null,
      keptUntil: { kind: "NEVER" },
      slotOrdinal: null,
      notice: null,
      parts: [
        {
          id: r.id,
          title,
          partLabel: null,
          recordedAt,
          durationInMinutes: r.durationInMinutes,
          keptUntil: { kind: "NEVER" },
        },
      ],
    };
  });
}

/** One library row per session slot: its parts, a catch-up, or a removal or decline notice. */
export function slotToLibraryRow(
  appointmentId: string,
  view: Pick<RecordingBookingView, "kind" | "slots">,
  slot: RecordingSlot,
): LibraryRecording | null {
  if (
    slot.parts.length === 0 &&
    slot.state !== "removed" &&
    slot.state !== "declined"
  ) {
    return null;
  }
  const sessionLabel = view.slots.length > 1 ? `Session ${slot.ordinal}` : null;
  const catchUpFrom =
    slot.source?.kind === "catch_up"
      ? `From another ${view.kind === "CLASS" ? "batch" : "run"} · ${day(slot.source.startsAt)}`
      : null;
  return {
    id: `${appointmentId}:slot-${slot.ordinal}`,
    title: slot.title,
    sessionLabel,
    recordedAt: slot.parts[0]?.recordedAt ?? slot.startsAt,
    durationInMinutes: slot.parts.reduce((t, p) => t + p.durationInMinutes, 0),
    catchUpFrom,
    keptUntil: slot.parts[0]?.keptUntil ?? null,
    slotOrdinal: slot.ordinal,
    notice: slot.parts.length === 0 ? slotStateText(slot, day) : null,
    parts: slot.parts.map((part) => ({
      id: part.recordingId,
      title: part.title,
      partLabel: partLabel(part),
      recordedAt: part.recordedAt,
      durationInMinutes: part.durationInMinutes,
      keptUntil: part.keptUntil,
    })),
  };
}

/** The candidates that render at least one row under `q`, in candidate order. */
export function renderedGroups(
  candidateIds: string[],
  views: Map<string, RecordingBookingView>,
  q: string,
): { appointmentId: string; files: LibraryRecording[] }[] {
  const needle = q.toLowerCase();
  return candidateIds.flatMap((appointmentId) => {
    const view = views.get(appointmentId);
    if (!view) return [];
    const files = view.slots
      .map((slot) => slotToLibraryRow(appointmentId, view, slot))
      .filter((f): f is LibraryRecording => f !== null);
    const kept =
      !needle || view.title.toLowerCase().includes(needle)
        ? files
        : files.filter(
            (f) =>
              f.title.toLowerCase().includes(needle) ||
              f.parts.some((p) => p.title.toLowerCase().includes(needle)),
          );
    return kept.length > 0 ? [{ appointmentId, files: kept }] : [];
  });
}

function expertProfileId(
  booking: LoadedRecordingView["booking"],
): string | null {
  return (
    booking.consultation?.consultationPlan.consultantProfileId ??
    booking.subscription?.subscriptionPlan.consultantProfileId ??
    booking.trial?.consultantProfileId ??
    booking.webinar?.webinarPlan.consultantProfileId ??
    booking.class?.classPlan.consultantProfileId ??
    null
  );
}

/** Names of the page's experts and learners, keyed by profile id. */
async function profileNames(
  loaded: LoadedRecordingView[],
): Promise<Map<string, string>> {
  const experts = loaded.flatMap(
    ({ booking }) => expertProfileId(booking) ?? [],
  );
  const learners = loaded.flatMap(
    ({ booking }) => learnerProfileId(booking) ?? [],
  );
  if (experts.length + learners.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { consultantProfile: { id: { in: experts } } },
        { consulteeProfile: { id: { in: learners } } },
      ],
    },
    select: {
      name: true,
      consultantProfile: { select: { id: true } },
      consulteeProfile: { select: { id: true } },
    },
  });
  const names = new Map<string, string>();
  for (const user of users) {
    if (user.consultantProfile) names.set(user.consultantProfile.id, user.name);
    if (user.consulteeProfile) names.set(user.consulteeProfile.id, user.name);
  }
  return names;
}

function librarySession(
  { view, booking, firstStartsAt }: LoadedRecordingView,
  names: Map<string, string>,
  learnerSide: boolean,
): LibrarySession {
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  const expertName = nameOf(expertProfileId(booking));
  return {
    appointmentId: booking.id,
    kind: booking.appointmentType as LibraryKind,
    title: view.title,
    startsAt:
      (
        firstStartsAt ?? booking.subscription?.schedulingPeriodStartsAt
      )?.toISOString() ?? null,
    sessionCount: null,
    expertName,
    counterpartName: learnerSide
      ? expertName
      : nameOf(learnerProfileId(booking)),
  };
}

export async function readRecordingLibrary(args: {
  userId: string;
  owner: LibraryOwner;
  query: LibraryQuery;
}): Promise<LibraryPage<LibraryRecording>> {
  const { userId, owner, query } = args;
  const learnerSide = owner.kind === "personal" && owner.side === "learner";
  const where = sessionsWhere(userId, owner, query);
  const skip = (query.page - 1) * LIBRARY_PAGE_SIZE;

  if (owner.kind === "org" && owner.everyone) {
    const [total, rows] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        select: sessionSelect,
        orderBy: { createdAt: "desc" },
        take: LIBRARY_PAGE_SIZE,
        skip,
      }),
    ]);
    const summaries = await everyoneSummaries(rows.map((row) => row.id));
    return {
      groups: rows.map((row) => ({
        session: { ...toSession(row, false), counterpartName: null },
        files: [],
        summary: {
          recordings: summaries.get(row.id) ?? { count: 0, minutes: 0 },
        },
      })),
      total,
      page: query.page,
      pageSize: LIBRARY_PAGE_SIZE,
    };
  }

  const candidates = await prisma.appointment.findMany({
    where,
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_CAP,
  });
  const ids = candidates.map((c) => c.id);
  const loaded = await loadRecordingViews(ids, userId);
  const views = new Map([...loaded].map(([id, l]) => [id, l.view]));
  const rendered = renderedGroups(ids, views, query.q);
  const page = rendered
    .slice(skip, skip + LIBRARY_PAGE_SIZE)
    .flatMap(({ appointmentId, files }) => {
      const hit = loaded.get(appointmentId);
      return hit ? [{ loaded: hit, files }] : [];
    });
  const names = await profileNames(page.map((g) => g.loaded));

  return {
    groups: page.map((g) => ({
      session: librarySession(g.loaded, names, learnerSide),
      files: g.files,
    })),
    total: rendered.length,
    page: query.page,
    pageSize: LIBRARY_PAGE_SIZE,
    ...(learnerSide && query.page === 1 && !query.kind && !query.person
      ? { purchased: await purchasedReplays(userId) }
      : {}),
  };
}
