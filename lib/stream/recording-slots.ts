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

const PLAYABLE: ReadonlySet<RecordingStatus> = new Set([
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
/** An expert-deleted recording reads as "Removed" for this long. */
const TOMBSTONE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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

type SessionRow = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof sessionSelect;
}>;
type RecordingRow = Prisma.RecordingGetPayload<{
  select: typeof recordingSelect;
}>;

const ownerSelect = { select: { userId: true } } as const;
const presenters = {
  where: { status: "ACCEPTED" as const, tier: "PRESENTER" as const },
  select: { consultantProfile: ownerSelect },
} as const;

const bookingSelect = {
  id: true,
  appointmentType: true,
  consultation: {
    select: {
      requestedBy: ownerSelect,
      consultationPlan: {
        select: { title: true, consultantProfile: ownerSelect },
      },
    },
  },
  subscription: {
    select: {
      requestedBy: ownerSelect,
      subscriptionPlan: {
        select: {
          title: true,
          consultantProfile: ownerSelect,
          subscriptionContents: { select: { order: true, title: true } },
        },
      },
    },
  },
  trial: {
    select: {
      consulteeProfile: ownerSelect,
      consultantProfile: ownerSelect,
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
          consultantProfile: ownerSelect,
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
          consultantProfile: ownerSelect,
          collaborators: presenters,
          classContents: { select: { order: true, title: true } },
        },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

type BookingRow = Prisma.AppointmentGetPayload<{
  select: typeof bookingSelect;
}>;

interface GroupPlan {
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

function hostUserIds(row: BookingRow): string[] {
  const plan = row.webinar?.webinarPlan ?? row.class?.classPlan;
  return [
    row.consultation?.consultationPlan.consultantProfile.userId,
    row.subscription?.subscriptionPlan.consultantProfile.userId,
    row.trial?.consultantProfile.userId,
    plan?.consultantProfile?.userId,
    ...(plan?.collaborators ?? []).map((c) => c.consultantProfile.userId),
  ].filter((id): id is string => Boolean(id));
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

async function holdsEntitledSeat(
  appointmentId: string,
  userId: string,
): Promise<boolean> {
  const [seat, payments] = await Promise.all([
    prisma.appointmentParticipant.count({
      where: {
        appointmentId,
        userId,
        role: "CONSULTEE",
        status: { in: [...ENTITLED_SEAT] },
      },
    }),
    prisma.payment.findMany({
      where: {
        appointmentId,
        userId,
        paymentStatus: "SUCCEEDED",
        deletedAt: null,
      },
      select: {
        amount: true,
        refunds: { select: { amountPaise: true, status: true } },
      },
    }),
  ]);
  return seat > 0 || payments.some(isPaymentEntitled);
}

export interface RecordingViewer {
  role: RecordingViewerRole;
  booking: BookingRow;
  groupPlan: GroupPlan | null;
}

/** The caller's side of a booking's recordings, or null when they are neither host nor entitled learner. */
export async function resolveRecordingViewer(
  appointmentId: string,
  userId: string,
): Promise<RecordingViewer | null> {
  const booking = await prisma.appointment.findFirst({
    where: { id: appointmentId, deletedAt: null },
    select: bookingSelect,
  });
  if (!booking) return null;
  const groupPlan = groupPlanOf(booking);
  if (hostUserIds(booking).includes(userId)) {
    return { role: "host", booking, groupPlan };
  }
  const oneToOneLearner =
    booking.consultation?.requestedBy.userId === userId ||
    booking.subscription?.requestedBy.userId === userId ||
    booking.trial?.consulteeProfile.userId === userId;
  if (oneToOneLearner) return { role: "learner", booking, groupPlan };
  if (groupPlan && (await holdsEntitledSeat(appointmentId, userId))) {
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

function missingReasonOf(
  sessions: SessionRow[],
  now: Date,
  oneToOne: boolean,
): { reason: SlotMissingReason; removedAt: Date | null } {
  const recordings = sessions.flatMap((s) => s.meeting?.recordings ?? []);
  const removed = recordings.find(
    (r) =>
      r.removalReason === "EXPERT_DELETED" &&
      r.removedAt &&
      now.getTime() - r.removedAt.getTime() < TOMBSTONE_DAYS * DAY_MS,
  );
  if (removed) return { reason: "removed", removedAt: removed.removedAt };
  // Only 1:1 sessions discard a recording when someone declines.
  const declined =
    oneToOne &&
    sessions.some((s) => (s.meeting?.recordingConsents.length ?? 0) > 0);
  if (declined || recordings.some((r) => r.removalReason === "DECLINED")) {
    return { reason: "declined", removedAt: null };
  }
  const expired = recordings.some(
    (r) =>
      r.removalReason === ("RETENTION" satisfies RecordingRemovalReason) ||
      r.removalReason === "COPY_LAPSED",
  );
  if (expired) return { reason: "expired", removedAt: null };
  return { reason: "not_recorded", removedAt: null };
}

interface CatchUpSource {
  appointmentId: string;
  batchLabel: string;
  startsAt: Date;
  sessions: SessionRow[];
}

/**
 * For each ordinal, the most recently ended same-ordinal session on another
 * run of the plan that has something playable; ties break on the run's id.
 */
async function catchUpSources(
  groupPlan: GroupPlan,
  ownAppointmentId: string,
  ordinals: number[],
  now: Date,
): Promise<Map<number, CatchUpSource>> {
  const sources = new Map<number, CatchUpSource>();
  if (ordinals.length === 0 || !groupPlan.sharesAcrossRuns) return sources;
  const samePlan: Prisma.AppointmentWhereInput =
    groupPlan.kind === "WEBINAR"
      ? { webinar: { webinarPlanId: groupPlan.planId } }
      : { class: { classPlanId: groupPlan.planId } };
  const rows = await prisma.appointmentOccurrence.findMany({
    where: {
      ordinal: { in: ordinals },
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
      endsAt: { lt: now },
      appointment: {
        id: { not: ownAppointmentId },
        deletedAt: null,
        ...samePlan,
      },
      meeting: {
        recordings: { some: { status: { in: [...PLAYABLE] } } },
      },
    },
    orderBy: [{ endsAt: "desc" }, { appointmentId: "asc" }],
    select: {
      ...sessionSelect,
      appointmentId: true,
      appointment: {
        select: {
          class: { select: { schedulingPeriodStartsAt: true } },
          occurrences: {
            where: { deletedAt: null },
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true },
          },
        },
      },
    },
  });
  for (const row of rows) {
    if (sources.has(row.ordinal)) continue;
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

/** The viewer's seat floor on this batch when the plan hides earlier sessions from late joiners. */
async function lateJoinFloor(
  viewer: RecordingViewer,
  userId: string,
): Promise<Date | null> {
  if (
    viewer.role !== "learner" ||
    viewer.groupPlan?.kind !== "CLASS" ||
    viewer.groupPlan.lateJoinersGetPastRecordings
  ) {
    return null;
  }
  const access = await lateJoinRecordingAccess(userId);
  return access.floors.get(viewer.booking.class?.id ?? "") ?? null;
}

/** The booking's recordings grouped into the viewer's session slots. */
export async function readRecordingSlots(
  viewer: RecordingViewer,
  userId: string,
  now: Date = new Date(),
): Promise<RecordingBookingView> {
  const { booking } = viewer;
  const sessions = await prisma.appointmentOccurrence.findMany({
    where: { appointmentId: booking.id, deletedAt: null },
    orderBy: [{ ordinal: "asc" }, { startsAt: "asc" }],
    select: sessionSelect,
  });
  const byOrdinal = new Map<number, SessionRow[]>();
  for (const session of sessions) {
    const list = byOrdinal.get(session.ordinal) ?? [];
    list.push(session);
    byOrdinal.set(session.ordinal, list);
  }

  const floor = await lateJoinFloor(viewer, userId);
  const isLearner = viewer.role === "learner";

  interface Draft {
    ordinal: number;
    rep: SessionRow;
    parts: { recording: RecordingRow; makeUp: boolean }[];
    state: SlotState;
    missing: { reason: SlotMissingReason; removedAt: Date | null } | null;
  }
  const drafts: Draft[] = [...byOrdinal.entries()].map(
    ([ordinal, slotSessions]) => {
      const live = slotSessions.filter(
        (s) => !DEAD_SESSION.has(s.completionStatus),
      );
      const rep = (live.length > 0 ? live : slotSessions).at(-1)!;
      const parts = playableParts(slotSessions);
      const beforeFloor = floor !== null && rep.startsAt < floor;
      if (isLearner && beforeFloor) {
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
      const missing = missingReasonOf(slotSessions, now, !viewer.groupPlan);
      return { ordinal, rep, parts, state: missing.reason, missing };
    },
  );

  const catchUpOrdinals =
    isLearner && viewer.groupPlan
      ? drafts.filter((d) => d.missing !== null).map((d) => d.ordinal)
      : [];
  const sources = viewer.groupPlan
    ? await catchUpSources(viewer.groupPlan, booking.id, catchUpOrdinals, now)
    : new Map<number, CatchUpSource>();

  const recordingIds = [
    ...drafts.flatMap((d) => d.parts.map((p) => p.recording.id)),
    ...[...sources.values()].flatMap((s) =>
      playableParts(s.sessions).map((p) => p.recording.id),
    ),
  ];
  const labels = await recordingRetentionLabels(recordingIds, now);

  const slots: RecordingSlot[] = drafts.map((d) => {
    const source = sources.get(d.ordinal);
    const base = {
      ordinal: d.ordinal,
      title: slotTitle(booking, d.ordinal),
      startsAt: d.rep.startsAt.toISOString(),
      missingReason: d.missing?.reason ?? null,
      removedAt: d.missing?.removedAt?.toISOString() ?? null,
    };
    if (source) {
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

  const samePlan: Prisma.AppointmentWhereInput =
    groupPlan.kind === "WEBINAR"
      ? { webinar: { webinarPlanId: groupPlan.planId } }
      : { class: { classPlanId: groupPlan.planId } };
  const ownRuns = await prisma.appointment.findMany({
    where: {
      id: { not: recordingAppointmentId },
      deletedAt: null,
      ...samePlan,
      ...entitledSeatWhere(userId),
    },
    select: { id: true },
  });

  let refusal: CatchUpRefusal = "FORBIDDEN";
  for (const run of ownRuns) {
    const viewer = await resolveRecordingViewer(run.id, userId);
    if (viewer?.role !== "learner") continue;
    const view = await readRecordingSlots(viewer, userId, now);
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
  const viewer = await resolveRecordingViewer(recording.appointmentId, userId);
  if (viewer?.role === "host") return { allowed: true };
  if (viewer?.role === "learner") {
    if (recording.expired) return { allowed: true };
    const view = await readRecordingSlots(viewer, userId);
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
