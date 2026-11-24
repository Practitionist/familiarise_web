/**
 * Occurrence builders, interval helpers, and join-window state predicates.
 * Each AppointmentOccurrence row represents one scheduled session with [startsAt, endsAt] bounds.
 */

import type { PrismaLike } from "@/lib/prisma";
import type { OccurrenceCompletionStatus, Prisma } from "@prisma/client";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import { endReasonPolicy } from "@/lib/meetings/end-reasons";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import {
  ScheduleLockedError,
  SESSION_ALREADY_HELD_MESSAGE,
} from "@/lib/events/schedule-lock";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import {
  sortOccurrences,
  toDate,
  toDateOrNull,
  toOccurrenceVM,
  type AppointmentKind,
  type AppointmentVM,
  type OccurrenceLike,
  type OccurrenceVM,
} from "./view-model";
import { normalizeOccurrences, type AnomalySink } from "./normalize";
import { bookingStatus, bookingStatusBadge } from "./booking-status";
import { isCompletedOccurrence } from "@/lib/booking/entitlement";
import { PARKED_OUTCOMES } from "@/lib/booking/misses";
import type { StatusBadgeStyle } from "@/lib/labels/session-labels";
import { formatInViewerZone } from "@/lib/time/viewer-zone";

/** The engine's unit of arithmetic: every interval and duration is a multiple. */
export const SCHEDULING_INTERVAL_MS = 30 * 60 * 1000;

export const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

/** Pre-start join window for consultees/attendees (15 minutes, symmetric with hosts and backstage). */
export const CONSULTEE_JOIN_WINDOW_MS = 15 * 60 * 1000;
/** Pre-start join window for consultants/hosts (15 minutes). */
export const CONSULTANT_JOIN_WINDOW_MS = 15 * 60 * 1000;
/** Post-end rejoin and overrun grace window (30 minutes). */
export const REJOIN_GRACE_MS = 30 * 60 * 1000;

export type OccurrenceJoinState =
  "disabled" | "countdown" | "joinable" | "ended";

export interface JoinableOccurrence {
  id: string;
  appointmentId?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  isTentative?: boolean | null;
  completionStatus?: string | null;
  deletedAt?: Date | string | null;
  meeting?: {
    id: string;
    endedAt: Date | string | null;
    endedReason: string | null;
  } | null;
}

export type OccurrenceInput = {
  startsAt: Date;
  durationInHours: number;
  consultantProfileId: string;
  isTentative?: boolean;
  ordinal?: number;
};

export type OccurrenceCreate = {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  consultantProfileId: string;
};

export function buildOccurrence(input: OccurrenceInput): OccurrenceCreate {
  const { startsAt, durationInHours, consultantProfileId } = input;
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) {
    throw new Error("buildOccurrence: invalid startsAt");
  }
  if (typeof durationInHours !== "number" || durationInHours <= 0) {
    throw new Error("buildOccurrence: durationInHours must be > 0");
  }
  const intervals = ScheduleCalculationService.getSlotsPerCall(durationInHours);
  return {
    ordinal: input.ordinal ?? 1,
    startsAt,
    endsAt: new Date(startsAt.getTime() + intervals * SCHEDULING_INTERVAL_MS),
    isTentative: input.isTentative ?? false,
    consultantProfileId,
  };
}

export function buildOccurrenceForWindow(
  input: Omit<OccurrenceInput, "startsAt" | "durationInHours"> & {
    startsAt: Date;
    endsAt: Date;
  },
): OccurrenceCreate {
  const { startsAt, endsAt, ...rest } = input;
  if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime())) {
    throw new Error("buildOccurrenceForWindow: invalid endsAt");
  }
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) {
    throw new Error("buildOccurrenceForWindow: invalid startsAt");
  }
  const spanMs = endsAt.getTime() - startsAt.getTime();
  if (spanMs <= 0) {
    throw new Error("Invalid occurrence: start must be before end");
  }
  return buildOccurrence({
    ...rest,
    startsAt,
    durationInHours: spanMs / (60 * 60 * 1000),
  });
}

export function intervalCountOf(occurrence: {
  startsAt: Date | string;
  endsAt: Date | string;
}): number {
  const start = new Date(occurrence.startsAt).getTime();
  const end = new Date(occurrence.endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 1;
  }
  return Math.ceil((end - start) / SCHEDULING_INTERVAL_MS);
}

export function intervalStartsOf(occurrence: {
  startsAt: Date | string;
  endsAt: Date | string;
}): Date[] {
  const start = new Date(occurrence.startsAt);
  return Array.from(
    { length: intervalCountOf(occurrence) },
    (_, i) => new Date(start.getTime() + i * SCHEDULING_INTERVAL_MS),
  );
}

/**
 * The booked session's length in minutes: the live session, else the latest row
 * (a released or cancelled row keeps its times); null when no row has times.
 */
export function bookedSessionMinutes(
  occurrences: readonly {
    startsAt: Date | string;
    endsAt?: Date | string | null;
    completionStatus?: string | null;
    deletedAt?: Date | string | null;
  }[],
): number | null {
  const timed = occurrences.filter((o) => o.endsAt);
  const live = timed.find(
    (o) =>
      !o.deletedAt &&
      (o.completionStatus === "SCHEDULED" ||
        o.completionStatus === "UNVERIFIED"),
  );
  const row =
    live ??
    timed.reduce<(typeof timed)[number] | undefined>(
      (latest, o) =>
        !latest ||
        new Date(o.startsAt).getTime() > new Date(latest.startsAt).getTime()
          ? o
          : latest,
      undefined,
    );
  if (!row?.endsAt) return null;
  const minutes =
    (new Date(row.endsAt).getTime() - new Date(row.startsAt).getTime()) /
    60_000;
  return minutes > 0 ? minutes : null;
}

export async function nextOrdinal(
  tx: PrismaLike,
  appointmentId: string,
): Promise<number> {
  const agg = await tx.appointmentOccurrence.aggregate({
    where: { appointmentId },
    _max: { ordinal: true },
  });
  return (agg._max.ordinal ?? 0) + 1;
}

/** Updates an appointment's live occurrence in place to preserve linked Meeting and Recording rows. */
export async function replaceOccurrence(
  tx: PrismaLike,
  args: {
    appointmentId: string;
    startsAt: Date;
    durationInHours: number;
    consultantProfileId: string;
    isTentative?: boolean;
  },
): Promise<{ occurrenceId: string }> {
  const existing = await tx.appointmentOccurrence.findMany({
    where: { appointmentId: args.appointmentId },
    orderBy: { startsAt: "asc" },
  });
  const live = existing.filter((row) => !isDeadOccurrence(row));
  const target = buildOccurrence({
    startsAt: args.startsAt,
    durationInHours: args.durationInHours,
    consultantProfileId: args.consultantProfileId,
    isTentative: args.isTentative ?? false,
  });

  if (live.length === 0) {
    // A released (RESCHEDULED) session is replaced: the new row takes its
    // ordinal and counts as a move, and the released rows stop holding time.
    const released = existing.filter(
      (row) => row.completionStatus === "RESCHEDULED" && !row.deletedAt,
    );
    const replaced = [...released].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0];
    if (released.length > 0) {
      await transitionOccurrenceCompletion(tx, {
        reason: "replaced by a new time",
        where: { id: { in: released.map((row) => row.id) } },
        to: "CANCELLED",
        data: { deletedAt: new Date() },
        fromIn: ["RESCHEDULED"],
        allowZero: true,
      });
    }
    const created = await tx.appointmentOccurrence.create({
      data: {
        appointmentId: args.appointmentId,
        ...target,
        ordinal:
          replaced?.ordinal ?? (await nextOrdinal(tx, args.appointmentId)),
        ...(replaced ? { movedAt: new Date() } : {}),
      },
    });
    await recomputeEarningsHold(tx, args.appointmentId);
    return { occurrenceId: created.id };
  }

  const [kept, ...surplus] = live;
  const moved =
    kept.startsAt.getTime() !== target.startsAt.getTime() ||
    kept.endsAt.getTime() !== target.endsAt.getTime();

  if (
    live.some((row) => SETTLED_COMPLETION_STATUSES.has(row.completionStatus))
  ) {
    const unchanged =
      surplus.length === 0 &&
      !moved &&
      kept.consultantProfileId === target.consultantProfileId;
    if (!unchanged) throw new ScheduleLockedError(SESSION_ALREADY_HELD_MESSAGE);
    return { occurrenceId: kept.id };
  }

  if (live.length > 1) {
    await tx.appointmentOccurrence.updateMany({
      where: { id: { in: live.map((row) => row.id) } },
      data: { isTentative: true },
    });
  }
  await tx.appointmentOccurrence.update({
    where: { id: kept.id },
    data: {
      startsAt: target.startsAt,
      endsAt: target.endsAt,
      isTentative: target.isTentative,
      consultantProfileId: target.consultantProfileId,
      ...(moved ? { movedAt: new Date() } : {}),
    },
  });
  if (surplus.length > 0) {
    await transitionOccurrenceCompletion(tx, {
      reason: "planner time edit",
      where: { id: { in: surplus.map((row) => row.id) } },
      to: "RESCHEDULED",
      data: { isTentative: true },
    });
  }
  await recomputeEarningsHold(tx, args.appointmentId);
  return { occurrenceId: kept.id };
}

const DEAD_COMPLETION_STATUS_LIST: OccurrenceCompletionStatus[] = [
  "CANCELLED",
  "RESCHEDULED",
];
const DEAD_COMPLETION_STATUSES = new Set<string>(DEAD_COMPLETION_STATUS_LIST);

const SETTLED_COMPLETION_STATUSES = new Set<string>([
  "COMPLETED",
  "UNVERIFIED",
  "VOIDED",
] satisfies OccurrenceCompletionStatus[]);

export const liveOccurrenceWhere = {
  deletedAt: null,
  completionStatus: { notIn: DEAD_COMPLETION_STATUS_LIST },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

export function isDeadOccurrence(occurrence: {
  completionStatus?: string | null;
  deletedAt?: Date | string | null;
}): boolean {
  if (occurrence.deletedAt) return true;
  return (
    !!occurrence.completionStatus &&
    DEAD_COMPLETION_STATUSES.has(occurrence.completionStatus)
  );
}

export function occurrencesAllowReschedule(
  occurrences: Array<{
    isTentative?: boolean | null;
    completionStatus?: string | null;
  }>,
): boolean {
  if (occurrences.length === 0) return false;
  if (occurrences[0]?.isTentative) return false;
  return !occurrences.some((row) => row.completionStatus === "RESCHEDULED");
}

/**
 * Whether the host may re-plan this booking's times without anyone's consent.
 * A webinar or class only while no seat is live: once sold, it is re-timed
 * (notice plus free leave), never re-planned. The allocator enforces the same
 * rule in its transaction (`assertGroupEventUnsoldInTx`).
 */
export function allowsManageTimings(
  kind: AppointmentKind,
  occurrences: Array<{ isTentative?: boolean | null }>,
  liveSeats: number,
): boolean {
  if (kind === "WEBINAR" || kind === "CLASS") return liveSeats === 0;
  if (occurrences.length === 0) return true;
  return occurrences.every((row) => Boolean(row.isTentative));
}

export function upcomingOccurrences<
  T extends {
    startsAt: Date | string;
    endsAt: Date | string;
    completionStatus?: string | null;
    deletedAt?: Date | string | null;
  },
>(occurrences: T[], now: Date = new Date()): T[] {
  const cutoff = now.getTime();
  return occurrences
    .filter(
      (row) => !isDeadOccurrence(row) && toDate(row.endsAt).getTime() >= cutoff,
    )
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
    );
}

function occurrenceTimes(occurrence: JoinableOccurrence): {
  start: number;
  end: number;
} {
  const start = toDate(occurrence.startsAt).getTime();
  const endsAt = toDateOrNull(occurrence.endsAt ?? null);
  return {
    start,
    end: endsAt ? endsAt.getTime() : start + DEFAULT_MEETING_DURATION_MS,
  };
}

/** True when a person or ops closed the room on purpose (`END_REASON_POLICY.deliberate`). */
export function isDeliberateEnd(
  session?: {
    endedAt: Date | string | null;
    endedReason?: string | null;
  } | null,
): boolean {
  if (!session?.endedAt) return false;
  return endReasonPolicy(session.endedReason).deliberate;
}

/** Join state of one occurrence over [startsAt - joinWindowMs, endsAt + rejoinGraceMs). */
export function getOccurrenceJoinState(
  occurrence: JoinableOccurrence,
  opts?: { joinWindowMs?: number; rejoinGraceMs?: number; now?: Date },
): OccurrenceJoinState {
  if (occurrence.isTentative) return "disabled";
  if (isDeadOccurrence(occurrence)) return "disabled";
  if (isDeliberateEnd(occurrence.meeting)) return "ended";

  const joinWindowMs = opts?.joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const rejoinGraceMs =
    opts?.rejoinGraceMs ??
    (occurrence.endsAt !== null && occurrence.endsAt !== undefined
      ? REJOIN_GRACE_MS
      : 0);
  const now = (opts?.now ?? new Date()).getTime();
  const { start, end } = occurrenceTimes(occurrence);

  if (rejoinGraceMs > 0 ? now >= end + rejoinGraceMs : now > end) {
    return "ended";
  }
  if (now >= start - joinWindowMs) return "joinable";
  return "countdown";
}

export function liveOccurrencesOf<T extends JoinableOccurrence>(
  occurrences: T[],
): T[] {
  return occurrences
    .filter((row) => !isDeadOccurrence(row))
    .sort((a, b) => occurrenceTimes(a).start - occurrenceTimes(b).start);
}

export function getJoinableOccurrence<T extends JoinableOccurrence>(
  occurrences: T[],
  opts?: { joinWindowMs?: number; rejoinGraceMs?: number; now?: Date },
): T | null {
  for (const row of liveOccurrencesOf(occurrences)) {
    if (getOccurrenceJoinState(row, opts) === "joinable") return row;
  }
  return null;
}

export function getCurrentOrNextOccurrence<T extends JoinableOccurrence>(
  occurrences: T[],
  now: Date = new Date(),
): T | null {
  const live = liveOccurrencesOf(occurrences);
  if (live.length === 0) return null;
  return (
    live.find((row) => occurrenceTimes(row).end >= now.getTime()) ??
    live[live.length - 1]
  );
}

/** Evaluates join state for an OccurrenceVM, keeping the Join button active through REJOIN_GRACE_MS. */
export function getOccurrenceVMJoinState(
  occurrence: OccurrenceVM,
  opts?: { joinWindowMs?: number; rejoinGraceMs?: number; now?: Date },
): OccurrenceJoinState {
  return getOccurrenceJoinState(
    {
      id: occurrence.occurrenceId,
      appointmentId: occurrence.appointmentId,
      startsAt: occurrence.startsAt,
      endsAt: occurrence.endsAt,
      isTentative: occurrence.isTentative,
      completionStatus: occurrence.completionStatus,
      meeting: occurrence.meetingEndedAt
        ? {
            id: occurrence.occurrenceId,
            endedAt: occurrence.meetingEndedAt,
            endedReason: occurrence.meetingEndedReason,
          }
        : null,
    },
    {
      ...opts,
      rejoinGraceMs:
        opts?.rejoinGraceMs ??
        (occurrence.endsAt !== null && occurrence.endsAt !== undefined
          ? REJOIN_GRACE_MS
          : 0),
    },
  );
}

export function meetingClosedAt(occurrence: OccurrenceVM): Date | null {
  return isDeliberateEnd({
    endedAt: occurrence.meetingEndedAt,
    endedReason: occurrence.meetingEndedReason,
  })
    ? occurrence.meetingEndedAt
    : null;
}

function occurrenceEnd(occurrence: OccurrenceVM): number {
  const closedAt = meetingClosedAt(occurrence);
  if (closedAt) return closedAt.getTime();
  return occurrence.endsAt
    ? occurrence.endsAt.getTime()
    : occurrence.startsAt.getTime() + DEFAULT_MEETING_DURATION_MS;
}

/** Occurrences that still count (not cancelled/rescheduled away). */
export function liveOccurrences(occurrences: OccurrenceVM[]): OccurrenceVM[] {
  return occurrences.filter((row) => !isDeadOccurrence(row));
}

export function isOccurrenceOver(
  occurrence: OccurrenceVM,
  now = new Date(),
): boolean {
  const closedAt = meetingClosedAt(occurrence);
  if (closedAt) return closedAt.getTime() < now.getTime();
  if (
    occurrence.completionStatus === "COMPLETED" ||
    occurrence.completionStatus === "VOIDED"
  ) {
    return occurrenceEnd(occurrence) < now.getTime();
  }
  const graceMs = occurrence.endsAt ? REJOIN_GRACE_MS : 0;
  return occurrenceEnd(occurrence) + graceMs < now.getTime();
}

/** A session's outcome is recorded: delivered, voided, or attended. One parked for ops on any booking is not held yet. */
export function isOccurrenceHeld(o: {
  completionStatus?: string | null;
  outcome?: string | null;
}): boolean {
  if (o.completionStatus === "UNVERIFIED" && isParkedOutcome(o.outcome)) {
    return false;
  }
  return (
    isCompletedOccurrence(o) || o.completionStatus === "VOIDED" || !!o.outcome
  );
}

const PARKED = new Set<string>(PARKED_OUTCOMES);
const isParkedOutcome = (outcome?: string | null) =>
  !!outcome && PARKED.has(outcome);

/** True when every live session's outcome is recorded or its call was ended by the host. */
export function allOccurrencesHeld(occurrences: OccurrenceVM[]): boolean {
  const live = liveOccurrences(occurrences);
  if (occurrences.length === 0) return false;
  if (live.length === 0) return true;
  return live.every((o) => isOccurrenceHeld(o) || meetingClosedAt(o) !== null);
}

/** True when the timeline has occurrences and every live one is over by the clock. */
export function allOccurrencesOver(
  occurrences: OccurrenceVM[],
  now = new Date(),
): boolean {
  const live = liveOccurrences(occurrences);
  if (occurrences.length === 0) return false;
  if (live.length === 0) return true;
  return live.every((row) => isOccurrenceOver(row, now));
}

/**
 * Day-group / sort anchor: the next live occurrence that hasn't ended, else
 * the most recent live one (so past rows group under their real date).
 */
export function getAnchorTime(
  occurrences: OccurrenceVM[],
  now = new Date(),
): Date | null {
  const live = liveOccurrences(occurrences);
  if (live.length === 0) return null;
  const upcoming = live.find((row) => !isOccurrenceOver(row, now));
  return upcoming?.startsAt ?? live[live.length - 1]?.startsAt ?? null;
}

/** Calendar days from `now` to `anchor` in `zone`; every future-relative label counts days with it. */
export function calendarDaysUntil(
  anchor: Date,
  zone: string,
  now = new Date(),
): number {
  // Zone-local dates read as UTC dates, so no DST hour skews the count.
  const dayIndex = (at: Date) =>
    Date.parse(`${formatInViewerZone(at, zone, "yyyy-MM-dd")}T00:00:00Z`) /
    86_400_000;
  return dayIndex(anchor) - dayIndex(now);
}

/**
 * Short human proximity label for an upcoming anchor ("in 45 min", "Today",
 * "Tomorrow", "in 8 days", "in 2 weeks"), with days counted in the viewer's
 * `zone`: days up to 13, then whole weeks rounded down. Null for past/absent
 * anchors; rows show the absolute time regardless.
 */
export function getProximityLabel(
  anchor: Date | null,
  zone: string,
  now = new Date(),
): string | null {
  if (!anchor) return null;
  const diffMs = anchor.getTime() - now.getTime();
  if (diffMs <= 0) return null;

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `in ${Math.max(diffMinutes, 1)} min`;

  const dayDiff = calendarDaysUntil(anchor, zone, now);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  if (dayDiff < 14) return `in ${dayDiff} days`;
  return `in ${Math.floor(dayDiff / 7)} weeks`;
}

/** Held when the outcome is recorded or the host ended the call; past-but-undecided is told apart. */
function listSessions(occurrences: OccurrenceVM[], live: OccurrenceVM[]) {
  const done = live.length > 0 && allOccurrencesHeld(occurrences);
  return {
    live: live.length,
    allTentative: live.length > 0 && live.every((s) => s.isTentative),
    done,
    awaitingOutcome:
      !done && live.length > 0 && allOccurrencesOver(occurrences),
  };
}

type ChipVM = Pick<AppointmentVM, "status" | "kind"> &
  Partial<
    Pick<
      AppointmentVM,
      | "occurrences"
      | "bookingSource"
      | "seatStatus"
      | "seatReleasedAt"
      | "paid"
      | "payDeadline"
      | "payLapsed"
      | "reschedule"
      | "refunded"
      | "unpaidLinkSeen"
      | "history"
      | "awaitingDecision"
    >
  >;

/** A list row's status, from the one status function and the facts the row carries. */
function rowBookingStatus(vm: ChipVM, role: "consultee" | "consultant") {
  const live = vm.occurrences ? liveOccurrences(vm.occurrences) : null;
  return bookingStatus(
    {
      kind: vm.kind,
      status: vm.status,
      source: vm.bookingSource,
      seatStatus: vm.seatStatus,
      seatReleasedAt: vm.seatReleasedAt,
      paid: vm.paid,
      payDeadline: vm.payDeadline,
      payLapsed: vm.payLapsed,
      reschedule: vm.reschedule,
      refunded: vm.refunded,
      unpaidLinkSeen: vm.unpaidLinkSeen,
      history: vm.history,
      awaitingDecision: vm.awaitingDecision,
      sessions:
        vm.occurrences && live ? listSessions(vm.occurrences, live) : undefined,
    },
    role === "consultant" ? "CONSULTANT" : "CONSULTEE",
  );
}

/** The status chip on every appointments surface, from the one status function. */
export function appointmentStatusChip(
  vm: ChipVM,
  role: "consultee" | "consultant",
): StatusBadgeStyle {
  return bookingStatusBadge(rowBookingStatus(vm, role));
}

/** The chip's reason line ("Payment was not completed in time."), empty when the word says it all. */
export function appointmentStatusLine(
  vm: ChipVM,
  role: "consultee" | "consultant",
): string {
  return rowBookingStatus(vm, role).line;
}

export interface OccurrenceSourceAppointment {
  id: string;
  occurrences?: OccurrenceLike[] | null;
}

/** One OccurrenceVM per drawable stored row (`normalizeOccurrences`), chronological. */
export function occurrencesOfAppointment(
  appointment: OccurrenceSourceAppointment | null | undefined,
  sink?: AnomalySink,
): OccurrenceVM[] {
  return sortOccurrences(
    normalizeOccurrences(appointment?.occurrences, sink).map((row) =>
      toOccurrenceVM({ ...row, appointmentId: appointment?.id ?? null }),
    ),
  );
}
