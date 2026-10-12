import "server-only";

import {
  RecordingStatus,
  type Prisma,
  type RecordingRemovalReason,
} from "@prisma/client";

import prisma from "@/lib/prisma";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";
import { lateJoinRecordingAccess } from "@/lib/stream/late-join-recordings";
import {
  recordingRetentionLabels,
  type RecordingRetentionLabel,
} from "@/lib/stream/recording-retention";

/**
 * The one rule for which recordings a viewer sees on a booking and may play:
 * their own run or batch by session (`ordinal`), several recordings of a
 * session as parts, and, for a learner whose own session ended with nothing
 * playable, a catch-up from the most recent other run of the same plan
 * (classes always, webinars when the plan shares recordings). The list and
 * playback both call it.
 */

export const PLAYABLE: ReadonlySet<RecordingStatus> = new Set([
  RecordingStatus.READY,
  RecordingStatus.TRANSFERRING,
  RecordingStatus.AVAILABLE,
]);
const IN_FLIGHT: ReadonlySet<RecordingStatus> = new Set([
  RecordingStatus.RECORDING,
  RecordingStatus.PROCESSING,
]);
const DEAD_SESSION = new Set(["CANCELLED", "RESCHEDULED"]);
const ENDED_SESSION = new Set(["COMPLETED", "UNVERIFIED", "VOIDED"]);
const ENTITLED_SEAT = ["CONFIRMED", "ATTENDED"] as const;

export type SlotState =
  | "recorded"
  | "catch_up"
  | "upcoming"
  | "processing"
  | "not_recorded"
  | "declined"
  | "removed"
  | "expired"
  | "before_you_joined";

export type SlotMissingReason = Extract<
  SlotState,
  "not_recorded" | "declined" | "removed" | "expired"
>;

export type RetentionLabelDTO =
  | { kind: "DATE"; until: string }
  | { kind: "WHILE_ACTIVE" }
  | { kind: "NEVER" };

export interface SlotPart {
  recordingId: string;
  title: string;
  partNo: number;
  partCount: number;
  recordedAt: string;
  durationInMinutes: number;
  makeUp: boolean;
  keptUntil: RetentionLabelDTO | null;
  /** Hosts only: what the manage sheet needs. */
  listing: { status: string; hasBuyers: boolean } | null;
}

export interface RecordingSlot {
  ordinal: number;
  title: string;
  startsAt: string;
  state: SlotState;
  /** Why the viewer's own session has nothing to play (set with catch_up too). */
  missingReason: SlotMissingReason | null;
  /** When an expert removed the session's recording. */
  removedAt: string | null;
  source:
    | { kind: "own" }
    | { kind: "catch_up"; batchLabel: string; startsAt: string }
    | null;
  parts: SlotPart[];
}

export type RecordingViewerRole = "host" | "learner";

export interface RecordingBookingView {
  appointmentId: string;
  kind: string;
  title: string;
  batchLabel: string | null;
  viewerRole: RecordingViewerRole;
  /** Who may watch: the booking's two parties, a run's attendees or a batch's members. */
  audience: "one_to_one" | "run" | "batch";
  /** Webinars: whether other runs' attendees may catch up from these recordings. */
  sharedAcrossRuns: boolean | null;
  slots: RecordingSlot[];
}

const recordingSelect = {
  id: true,
  title: true,
  status: true,
  durationInMinutes: true,
  recordedAt: true,
  removedAt: true,
  removalReason: true,
  listingStatus: true,
  purchases: {
    where: { status: { in: ["PENDING", "SUCCEEDED"] } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.RecordingSelect;

const sessionSelect = {
  id: true,
  ordinal: true,
  startsAt: true,
  endsAt: true,
  completionStatus: true,
  voidedAt: true,
  meeting: {
    select: {
      endedAt: true,
      recordings: { select: recordingSelect, orderBy: { recordedAt: "asc" } },
      recordingConsents: {
        where: { decision: "DECLINED" },
        select: { id: true },
        take: 1,
      },
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

export type SessionRow = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof sessionSelect;
}>;
type RecordingRow = Prisma.RecordingGetPayload<{
  select: typeof recordingSelect;
}>;

const presenters = {
  where: { status: "ACCEPTED" as const, tier: "PRESENTER" as const },
  select: { consultantProfileId: true },
} as const;

/** Parties are compared by profile id, so the read stops at the plan. */
const bookingSelect = {
  id: true,
  appointmentType: true,
  consultation: {
    select: {
      requestedById: true,
      consultationPlan: { select: { title: true, consultantProfileId: true } },
    },
  },
  subscription: {
    select: {
      requestedById: true,
      schedulingPeriodStartsAt: true,
      subscriptionPlan: {
        select: {
          title: true,
          consultantProfileId: true,
          subscriptionContents: { select: { order: true, title: true } },
        },
      },
    },
  },
  trial: {
    select: {
      consulteeProfileId: true,
      consultantProfileId: true,
      subscriptionPlan: { select: { title: true } },
    },
  },
  webinar: {
    select: {
      id: true,
      webinarPlan: {
        select: {
          id: true,
          title: true,
          shareRecordingsWithAllAttendees: true,
          consultantProfileId: true,
          collaborators: presenters,
        },
      },
    },
  },
  class: {
    select: {
      id: true,
      schedulingPeriodStartsAt: true,
      classPlan: {
        select: {
          id: true,
          title: true,
          lateJoinersGetPastRecordings: true,
          consultantProfileId: true,
          collaborators: presenters,
          classContents: { select: { order: true, title: true } },
        },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

export type BookingRow = Prisma.AppointmentGetPayload<{
  select: typeof bookingSelect;
}>;

export interface GroupPlan {
  kind: "WEBINAR" | "CLASS";
  planId: string;
  /** Catch-up across runs is allowed for this plan. */
  sharesAcrossRuns: boolean;
  lateJoinersGetPastRecordings: boolean;
}

function groupPlanOf(row: BookingRow): GroupPlan | null {
  if (row.webinar) {
    return {
      kind: "WEBINAR",
      planId: row.webinar.webinarPlan.id,
      sharesAcrossRuns: row.webinar.webinarPlan.shareRecordingsWithAllAttendees,
      lateJoinersGetPastRecordings: true,
    };
  }
  if (row.class) {
    return {
      kind: "CLASS",
      planId: row.class.classPlan.id,
      sharesAcrossRuns: true,
      lateJoinersGetPastRecordings:
        row.class.classPlan.lateJoinersGetPastRecordings,
    };
  }
  return null;
}

function titleOf(row: BookingRow): string {
  return (
    row.consultation?.consultationPlan.title ??
    row.subscription?.subscriptionPlan.title ??
    row.trial?.subscriptionPlan.title ??
    row.webinar?.webinarPlan.title ??
    row.class?.classPlan.title ??
    "Session"
  );
}

/** The booking's host-side consultant profiles: owner and accepted presenters. */
function hostProfileIds(row: BookingRow): string[] {
  const plan = row.webinar?.webinarPlan ?? row.class?.classPlan;
  return [
    row.consultation?.consultationPlan.consultantProfileId,
    row.subscription?.subscriptionPlan.consultantProfileId,
    row.trial?.consultantProfileId,
    plan?.consultantProfileId,
    ...(plan?.collaborators ?? []).map((c) => c.consultantProfileId),
  ].filter((id): id is string => Boolean(id));
}

/** The booking's 1:1 learner profile, if any. */
export function learnerProfileId(row: BookingRow): string | null {
  return (
    row.consultation?.requestedById ??
    row.subscription?.requestedById ??
    row.trial?.consulteeProfileId ??
    null
  );
}

/** Entitled seat holders of a group run: a confirmed seat or a payment not fully refunded. */
function entitledSeatWhere(userId: string): Prisma.AppointmentWhereInput {
  return {
    OR: [
      {
        participants: {
          some: {
            userId,
            role: "CONSULTEE",
            status: { in: [...ENTITLED_SEAT] },
          },
        },
      },
      {
        payment: {
          some: { userId, paymentStatus: "SUCCEEDED", deletedAt: null },
        },
      },
    ],
  };
}

export interface RecordingViewer {
  role: RecordingViewerRole;
  booking: BookingRow;
  groupPlan: GroupPlan | null;
}

/** The viewer's profiles, which parties are matched on. */
export interface RecordingIdentity {
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
}

/** The caller's side of a booking, or null when they are neither host nor entitled learner. */
export function recordingViewerOf(
  booking: BookingRow,
  identity: RecordingIdentity,
  holdsSeat: boolean,
): RecordingViewer | null {
  const groupPlan = groupPlanOf(booking);
  const { consultantProfileId, consulteeProfileId } = identity;
  if (
    consultantProfileId &&
    hostProfileIds(booking).includes(consultantProfileId)
  ) {
    return { role: "host", booking, groupPlan };
  }
  const oneToOneLearner =
    consulteeProfileId !== null &&
    learnerProfileId(booking) === consulteeProfileId;
  if (oneToOneLearner || (groupPlan && holdsSeat)) {
    return { role: "learner", booking, groupPlan };
  }
  return null;
}

function slotTitle(booking: BookingRow, ordinal: number): string {
  const contents =
    booking.class?.classPlan.classContents ??
    booking.subscription?.subscriptionPlan.subscriptionContents ??
    [];
  return (
    contents.find((c) => c.order === ordinal)?.title ?? `Session ${ordinal}`
  );
}

const dayLabel = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "Asia/Kolkata",
});

export function batchLabelFor(startsAt: Date | null): string | null {
  return startsAt
    ? `the batch that started ${dayLabel.format(startsAt)}`
    : null;
}

function sessionEnded(session: SessionRow, now: Date): boolean {
  if (DEAD_SESSION.has(session.completionStatus)) return true;
  if (ENDED_SESSION.has(session.completionStatus)) return true;
  if (session.meeting?.endedAt) return true;
  return session.endsAt.getTime() < now.getTime();
}

function playableParts(
  sessions: SessionRow[],
): { recording: RecordingRow; makeUp: boolean }[] {
  const ordered = [...sessions].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const hasVoided = ordered.some((s) => s.voidedAt !== null);
  return ordered.flatMap((session) =>
    (session.meeting?.recordings ?? [])
      .filter((r) => PLAYABLE.has(r.status))
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
      .map((recording) => ({
        recording,
        makeUp: hasVoided && session.voidedAt === null,
      })),
  );
}

function toParts(
  parts: { recording: RecordingRow; makeUp: boolean }[],
  labels: Map<string, RecordingRetentionLabel>,
  host: boolean,
): SlotPart[] {
  return parts.map(({ recording, makeUp }, index) => {
    const label = labels.get(recording.id);
    return {
      recordingId: recording.id,
      title: recording.title,
      partNo: index + 1,
      partCount: parts.length,
      recordedAt: recording.recordedAt.toISOString(),
      durationInMinutes: recording.durationInMinutes,
      makeUp,
      keptUntil: label
        ? label.kind === "DATE"
          ? { kind: "DATE", until: label.until.toISOString() }
          : label
        : null,
      listing: host
        ? {
            status: recording.listingStatus,
            hasBuyers: recording.purchases.length > 0,
          }
        : null,
    };
  });
}

/** An expert-deleted recording reads "Removed" until the date it would have been deleted anyway. */
export function tombstoneVisible(
  label: RecordingRetentionLabel | undefined,
  now: Date,
): boolean {
  return label?.kind !== "DATE" || label.until.getTime() > now.getTime();
}

function missingReasonOf(
  sessions: SessionRow[],
  now: Date,
  oneToOne: boolean,
  removedLabels: Map<string, RecordingRetentionLabel>,
): { reason: SlotMissingReason; removedAt: Date | null } {
  const recordings = sessions.flatMap((s) => s.meeting?.recordings ?? []);
  const deleted = recordings.filter(
    (r) => r.removalReason === "EXPERT_DELETED",
  );
  const removed = deleted.find((r) =>
    tombstoneVisible(removedLabels.get(r.id), now),
  );
  if (removed) return { reason: "removed", removedAt: removed.removedAt };
  // Only 1:1 sessions discard a recording when someone declines.
  const declined =
    oneToOne &&
    sessions.some((s) => (s.meeting?.recordingConsents.length ?? 0) > 0);
  if (declined || recordings.some((r) => r.removalReason === "DECLINED")) {
    return { reason: "declined", removedAt: null };
  }
  // A session that was recorded never reads "Not recorded".
  const expired = recordings.some(
    (r) =>
      r.status === RecordingStatus.EXPIRED ||
      r.removalReason === ("RETENTION" satisfies RecordingRemovalReason) ||
      r.removalReason === "COPY_LAPSED",
  );
  if (expired || deleted.length > 0) {
    return { reason: "expired", removedAt: null };
  }
  return { reason: "not_recorded", removedAt: null };
}

export interface CatchUpSource {
  appointmentId: string;
  batchLabel: string;
  startsAt: Date;
  sessions: SessionRow[];
}

const catchUpRowSelect = {
  ...sessionSelect,
  appointmentId: true,
  appointment: {
    select: {
      webinar: { select: { webinarPlanId: true } },
      class: { select: { classPlanId: true, schedulingPeriodStartsAt: true } },
      occurrences: {
        where: { deletedAt: null },
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true },
      },
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

export type CatchUpRow = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof catchUpRowSelect;
}>;

function samePlanWhere(groupPlan: GroupPlan): Prisma.AppointmentWhereInput {
  return groupPlan.kind === "WEBINAR"
    ? { webinar: { webinarPlanId: groupPlan.planId } }
    : { class: { classPlanId: groupPlan.planId } };
}

/**
 * For each ordinal, the most recently ended same-ordinal session on another
 * run of the plan that has something playable; ties break on the run's id.
 * `rows` must be ordered by `endsAt` desc, then `appointmentId` asc.
 */
export function pickCatchUpSources(
  groupPlan: GroupPlan,
  ownAppointmentId: string,
  ordinals: number[],
  rows: CatchUpRow[],
): Map<number, CatchUpSource> {
  const sources = new Map<number, CatchUpSource>();
  if (ordinals.length === 0 || !groupPlan.sharesAcrossRuns) return sources;
  const wanted = new Set(ordinals);
  for (const row of rows) {
    const planId =
      groupPlan.kind === "WEBINAR"
        ? row.appointment.webinar?.webinarPlanId
        : row.appointment.class?.classPlanId;
    if (planId !== groupPlan.planId || row.appointmentId === ownAppointmentId)
      continue;
    if (!wanted.has(row.ordinal) || sources.has(row.ordinal)) continue;
    const startedAt =
      row.appointment.class?.schedulingPeriodStartsAt ??
      row.appointment.occurrences[0]?.startsAt ??
      row.startsAt;
    sources.set(row.ordinal, {
      appointmentId: row.appointmentId,
      batchLabel:
        batchLabelFor(startedAt) ??
        (groupPlan.kind === "CLASS" ? "another batch" : "another run"),
      startsAt: startedAt,
      sessions: [row],
    });
  }
  return sources;
}

function hidesEarlierSessions(viewer: RecordingViewer): boolean {
  return (
    viewer.role === "learner" &&
    viewer.groupPlan?.kind === "CLASS" &&
    !viewer.groupPlan.lateJoinersGetPastRecordings
  );
}

/** The viewer's seat floor on this batch when the plan hides earlier sessions from late joiners. */
function lateJoinFloor(
  viewer: RecordingViewer,
  floors: ReadonlyMap<string, Date>,
): Date | null {
  if (!hidesEarlierSessions(viewer)) return null;
  return floors.get(viewer.booking.class?.id ?? "") ?? null;
}

interface Draft {
  ordinal: number;
  rep: SessionRow;
  parts: { recording: RecordingRow; makeUp: boolean }[];
  state: SlotState;
  missing: { reason: SlotMissingReason; removedAt: Date | null } | null;
}

function draftSlots(
  viewer: RecordingViewer,
  sessions: SessionRow[],
  floor: Date | null,
  labels: Map<string, RecordingRetentionLabel>,
  now: Date,
): Draft[] {
  const byOrdinal = new Map<number, SessionRow[]>();
  for (const session of sessions) {
    const list = byOrdinal.get(session.ordinal) ?? [];
    list.push(session);
    byOrdinal.set(session.ordinal, list);
  }
  const isLearner = viewer.role === "learner";
  return [...byOrdinal.entries()].map(([ordinal, slotSessions]) => {
    const live = slotSessions.filter(
      (s) => !DEAD_SESSION.has(s.completionStatus),
    );
    const rep = (live.length > 0 ? live : slotSessions).at(-1)!;
    const parts = playableParts(slotSessions);
    if (isLearner && floor !== null && rep.startsAt < floor) {
      return {
        ordinal,
        rep,
        parts: [],
        state: "before_you_joined",
        missing: null,
      };
    }
    if (parts.length > 0) {
      return { ordinal, rep, parts, state: "recorded", missing: null };
    }
    if (!sessionEnded(rep, now)) {
      return { ordinal, rep, parts, state: "upcoming", missing: null };
    }
    const inFlight = slotSessions.some((s) =>
      (s.meeting?.recordings ?? []).some((r) => IN_FLIGHT.has(r.status)),
    );
    if (inFlight) {
      return { ordinal, rep, parts, state: "processing", missing: null };
    }
    const missing = missingReasonOf(
      slotSessions,
      now,
      !viewer.groupPlan,
      labels,
    );
    return { ordinal, rep, parts, state: missing.reason, missing };
  });
}

/** The ordinals a learner's own run ended with nothing playable, so may fill from another run. */
export function catchUpOrdinals(
  viewer: RecordingViewer,
  sessions: SessionRow[],
  floor: Date | null,
  now: Date,
): number[] {
  if (viewer.role !== "learner" || !viewer.groupPlan?.sharesAcrossRuns) {
    return [];
  }
  return draftSlots(viewer, sessions, floor, new Map(), now)
    .filter((d) => d.missing !== null)
    .map((d) => d.ordinal);
}

/** Everything the slot rule reads beyond the booking, preloaded by the caller. */
export interface SlotInputs {
  /** The booking's live occurrences, by ordinal then start. */
  sessions: SessionRow[];
  floor: Date | null;
  sources: Map<number, CatchUpSource>;
  /** Retention labels for own recordings and catch-up parts. */
  labels: Map<string, RecordingRetentionLabel>;
}

/** The booking's recordings grouped into the viewer's session slots. */
export function buildRecordingView(
  viewer: RecordingViewer,
  { sessions, floor, sources, labels }: SlotInputs,
  now: Date,
): RecordingBookingView {
  const { booking } = viewer;
  const slots: RecordingSlot[] = draftSlots(
    viewer,
    sessions,
    floor,
    labels,
    now,
  ).map((d) => {
    const source = d.missing ? sources.get(d.ordinal) : undefined;
    const base = {
      ordinal: d.ordinal,
      title: slotTitle(booking, d.ordinal),
      startsAt: d.rep.startsAt.toISOString(),
      missingReason: d.missing?.reason ?? null,
      removedAt: d.missing?.removedAt?.toISOString() ?? null,
    };
    if (source && viewer.role === "learner") {
      return {
        ...base,
        state: "catch_up",
        source: {
          kind: "catch_up",
          batchLabel: source.batchLabel,
          startsAt: source.startsAt.toISOString(),
        },
        parts: toParts(playableParts(source.sessions), labels, false),
      };
    }
    return {
      ...base,
      state: d.state,
      source: d.parts.length > 0 ? { kind: "own" } : null,
      parts: toParts(d.parts, labels, viewer.role === "host"),
    };
  });

  return {
    appointmentId: booking.id,
    kind: booking.appointmentType,
    title: titleOf(booking),
    batchLabel: booking.class
      ? batchLabelFor(
          booking.class.schedulingPeriodStartsAt ??
            sessions[0]?.startsAt ??
            null,
        )
      : null,
    viewerRole: viewer.role,
    audience:
      viewer.groupPlan?.kind === "WEBINAR"
        ? "run"
        : viewer.groupPlan?.kind === "CLASS"
          ? "batch"
          : "one_to_one",
    sharedAcrossRuns:
      viewer.groupPlan?.kind === "WEBINAR"
        ? viewer.groupPlan.sharesAcrossRuns
        : null,
    slots,
  };
}

function viewerBookingSelect(userId: string) {
  return {
    ...bookingSelect,
    participants: {
      where: {
        userId,
        role: "CONSULTEE" as const,
        status: { in: [...ENTITLED_SEAT] },
      },
      select: { id: true },
      take: 1,
    },
    payment: {
      where: { userId, paymentStatus: "SUCCEEDED" as const, deletedAt: null },
      select: {
        amount: true,
        refunds: { select: { amountPaise: true, status: true } },
      },
    },
    occurrences: {
      where: { deletedAt: null },
      orderBy: [{ ordinal: "asc" as const }, { startsAt: "asc" as const }],
      select: sessionSelect,
    },
  } satisfies Prisma.AppointmentSelect;
}

/** One read for the catch-up candidates of every (plan, ordinal) the page needs. */
async function readCatchUpRows(
  needs: { groupPlan: GroupPlan; ordinals: number[] }[],
  now: Date,
): Promise<CatchUpRow[]> {
  const byPlan = new Map<
    string,
    { groupPlan: GroupPlan; ordinals: Set<number> }
  >();
  for (const { groupPlan, ordinals } of needs) {
    if (ordinals.length === 0) continue;
    const key = `${groupPlan.kind}:${groupPlan.planId}`;
    const entry = byPlan.get(key) ?? { groupPlan, ordinals: new Set() };
    for (const ordinal of ordinals) entry.ordinals.add(ordinal);
    byPlan.set(key, entry);
  }
  if (byPlan.size === 0) return [];
  return prisma.appointmentOccurrence.findMany({
    where: {
      OR: [...byPlan.values()].map(({ groupPlan, ordinals }) => ({
        ordinal: { in: [...ordinals] },
        appointment: { deletedAt: null, ...samePlanWhere(groupPlan) },
      })),
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      endsAt: { lt: now },
      meeting: {
        recordings: { some: { status: { in: [...PLAYABLE] } } },
      },
    },
    orderBy: [{ endsAt: "desc" }, { appointmentId: "asc" }],
    select: catchUpRowSelect,
  });
}

/** Recordings whose retention label the view shows or needs to decide a tombstone. */
function labelledRecordingIds(
  sessions: SessionRow[],
  sources: Map<number, CatchUpSource>,
): string[] {
  return [
    ...sessions.flatMap((s) =>
      (s.meeting?.recordings ?? [])
        .filter(
          (r) => PLAYABLE.has(r.status) || r.removalReason === "EXPERT_DELETED",
        )
        .map((r) => r.id),
    ),
    ...[...sources.values()].flatMap((s) =>
      playableParts(s.sessions).map((p) => p.recording.id),
    ),
  ];
}

async function readIdentity(userId: string): Promise<RecordingIdentity> {
  const [consultant, consultee] = await Promise.all([
    prisma.consultantProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
    prisma.consulteeProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
  ]);
  return {
    consultantProfileId: consultant?.id ?? null,
    consulteeProfileId: consultee?.id ?? null,
  };
}

export interface LoadedRecordingView {
  view: RecordingBookingView;
  booking: BookingRow;
  /** The booking's earliest live occurrence. */
  firstStartsAt: Date | null;
}

/**
 * Slot views for every booking the viewer is party to, in a fixed number of
 * reads whatever the count: identity, bookings with sessions, late-join
 * floors, catch-up candidates and retention labels.
 */
export async function loadRecordingViews(
  appointmentIds: string[],
  userId: string,
  now: Date = new Date(),
): Promise<Map<string, LoadedRecordingView>> {
  const loaded = new Map<string, LoadedRecordingView>();
  if (appointmentIds.length === 0) return loaded;
  const identity = await readIdentity(userId);
  const rows = await prisma.appointment.findMany({
    where: { id: { in: appointmentIds }, deletedAt: null },
    select: viewerBookingSelect(userId),
  });
  const viewers = rows.flatMap((row) => {
    const holdsSeat =
      row.participants.length > 0 || row.payment.some(isPaymentEntitled);
    const viewer = recordingViewerOf(row, identity, holdsSeat);
    return viewer ? [{ viewer, sessions: row.occurrences }] : [];
  });
  const floors = viewers.some(({ viewer }) => hidesEarlierSessions(viewer))
    ? (await lateJoinRecordingAccess(userId)).floors
    : new Map<string, Date>();
  const drafts = viewers.map(({ viewer, sessions }) => {
    const floor = lateJoinFloor(viewer, floors);
    return {
      viewer,
      sessions,
      floor,
      ordinals: catchUpOrdinals(viewer, sessions, floor, now),
    };
  });
  const catchUpRows = await readCatchUpRows(
    drafts.flatMap(({ viewer, ordinals }) =>
      viewer.groupPlan ? [{ groupPlan: viewer.groupPlan, ordinals }] : [],
    ),
    now,
  );
  const withSources = drafts.map((d) => ({
    ...d,
    sources: d.viewer.groupPlan
      ? pickCatchUpSources(
          d.viewer.groupPlan,
          d.viewer.booking.id,
          d.ordinals,
          catchUpRows,
        )
      : new Map<number, CatchUpSource>(),
  }));
  const labels = await recordingRetentionLabels(
    withSources.flatMap((d) => labelledRecordingIds(d.sessions, d.sources)),
    now,
  );
  for (const d of withSources) {
    const starts = d.sessions.map((s) => s.startsAt.getTime());
    loaded.set(d.viewer.booking.id, {
      view: buildRecordingView(d.viewer, { ...d, labels }, now),
      booking: d.viewer.booking,
      firstStartsAt: starts.length > 0 ? new Date(Math.min(...starts)) : null,
    });
  }
  return loaded;
}

/** One booking's slot view, or null when the viewer is neither host nor entitled learner. */
export async function loadRecordingView(
  appointmentId: string,
  userId: string,
  now: Date = new Date(),
): Promise<RecordingBookingView | null> {
  const loaded = await loadRecordingViews([appointmentId], userId, now);
  return loaded.get(appointmentId)?.view ?? null;
}

export type CatchUpRefusal =
  "FORBIDDEN" | "OWN_RECORDING_AVAILABLE" | "LATE_JOIN_HIDDEN";

/**
 * Playback's cross-run arm: the viewer is entitled to another run of the
 * recording's plan, and that run's same session is a catch-up slot whose
 * chosen source is this recording's run.
 */
export async function catchUpPlaybackAccess(
  recordingAppointmentId: string,
  ordinal: number,
  userId: string,
  now: Date = new Date(),
): Promise<{ allowed: true } | { allowed: false; code: CatchUpRefusal }> {
  const recordingBooking = await prisma.appointment.findFirst({
    where: { id: recordingAppointmentId },
    select: bookingSelect,
  });
  const groupPlan = recordingBooking ? groupPlanOf(recordingBooking) : null;
  if (!groupPlan?.sharesAcrossRuns)
    return { allowed: false, code: "FORBIDDEN" };

  const ownRuns = await prisma.appointment.findMany({
    where: {
      id: { not: recordingAppointmentId },
      deletedAt: null,
      ...samePlanWhere(groupPlan),
      ...entitledSeatWhere(userId),
    },
    select: { id: true },
  });
  const views = await loadRecordingViews(
    ownRuns.map((run) => run.id),
    userId,
    now,
  );

  let refusal: CatchUpRefusal = "FORBIDDEN";
  for (const run of ownRuns) {
    const view = views.get(run.id)?.view;
    if (view?.viewerRole !== "learner") continue;
    const slot = view.slots.find((s) => s.ordinal === ordinal);
    if (!slot) continue;
    if (slot.state === "catch_up") {
      const fromThisRun = await prisma.recording.count({
        where: {
          id: { in: slot.parts.map((p) => p.recordingId) },
          meeting: { occurrence: { appointmentId: recordingAppointmentId } },
        },
      });
      if (fromThisRun > 0) return { allowed: true };
    }
    refusal =
      slot.state === "before_you_joined"
        ? "LATE_JOIN_HIDDEN"
        : "OWN_RECORDING_AVAILABLE";
  }
  return { allowed: false, code: refusal };
}

/**
 * Whether the viewer may play this recording as its host, a learner whose
 * slot lists it, a replay buyer or through catch-up. Operator and
 * organisation roles are decided by the playback route.
 */
export async function viewerPlaybackAccess(
  userId: string,
  recording: {
    id: string;
    appointmentId: string;
    ordinal: number;
    expired: boolean;
  },
): Promise<{ allowed: true } | { allowed: false; code: CatchUpRefusal }> {
  const view = await loadRecordingView(recording.appointmentId, userId);
  if (view?.viewerRole === "host") return { allowed: true };
  if (view?.viewerRole === "learner") {
    if (recording.expired) return { allowed: true };
    if (
      view.slots.some((s) =>
        s.parts.some((p) => p.recordingId === recording.id),
      )
    ) {
      return { allowed: true };
    }
    const own = view.slots.find((s) => s.ordinal === recording.ordinal);
    if (own?.state === "before_you_joined") {
      return { allowed: false, code: "LATE_JOIN_HIDDEN" };
    }
  }
  const purchase = await prisma.recordingPurchase.count({
    where: { recordingId: recording.id, buyerId: userId, status: "SUCCEEDED" },
  });
  if (purchase > 0) return { allowed: true };
  return catchUpPlaybackAccess(
    recording.appointmentId,
    recording.ordinal,
    userId,
  );
}
