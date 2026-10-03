/**
 * Occurrence builders, interval helpers, and join-window state predicates.
 * Each AppointmentOccurrence row represents one scheduled session with [startsAt, endsAt] bounds.
 */

import type { PrismaLike } from "@/lib/prisma";
import type { OccurrenceCompletionStatus, Prisma } from "@prisma/client";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
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
  type OccurrenceLike,
  type OccurrenceVM,
} from "./view-model";

/** The engine's unit of arithmetic: every interval and duration is a multiple. */
export const SCHEDULING_INTERVAL_MS = 30 * 60 * 1000;

export const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

/** Pre-start join window for consultees/attendees (10 minutes). */
export const CONSULTEE_JOIN_WINDOW_MS = 10 * 60 * 1000;
/** Pre-start join window for consultants/hosts (15 minutes). */
export const CONSULTANT_JOIN_WINDOW_MS = 15 * 60 * 1000;
/** Post-end rejoin and overrun grace window (30 minutes). */
export const REJOIN_GRACE_MS = 30 * 60 * 1000;

export type OccurrenceJoinState =
  | "disabled"
  | "countdown"
  | "joinable"
  | "ended";

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
    const replaced = existing
      .filter((row) => row.completionStatus === "RESCHEDULED")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const created = await tx.appointmentOccurrence.create({
      data: {
        appointmentId: args.appointmentId,
        ...target,
        ordinal:
          replaced?.ordinal ?? (await nextOrdinal(tx, args.appointmentId)),
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

export function allowsManageTimings(
  kind: AppointmentKind,
  occurrences: Array<{ isTentative?: boolean | null }>,
): boolean {
  if (kind === "WEBINAR" || kind === "CLASS") return true;
  if (occurrences.length === 0) return true;
  return occurrences.every((row) => Boolean(row.isTentative));
}

export function allowsUnschedule(
  kind: AppointmentKind,
  occurrences: Array<{ isTentative?: boolean | null }>,
): boolean {
  if (kind !== "WEBINAR" && kind !== "CLASS") return false;
  return occurrences.some((row) => !row.isTentative);
}

export function upcomingOccurrences<
  T extends { startsAt: Date | string; endsAt: Date | string },
>(occurrences: T[], now: Date = new Date()): T[] {
  const cutoff = now.getTime();
  return occurrences
    .filter((row) => toDate(row.endsAt).getTime() >= cutoff)
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

/** Terminal reasons that permanently close a room without allowing rejoin. */
const DELIBERATE_END_REASONS = new Set(["call_ended", "maintenance"]);

export function isDeliberateEnd(
  session?: {
    endedAt: Date | string | null;
    endedReason?: string | null;
  } | null,
): boolean {
  if (!session?.endedAt) return false;
  return session.endedReason
    ? DELIBERATE_END_REASONS.has(session.endedReason)
    : true;
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
    (occurrence.endsAt != null && occurrence.meeting !== undefined
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
        (occurrence.endsAt != null ? REJOIN_GRACE_MS : 0),
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
  return occurrenceEnd(occurrence) < now.getTime();
}

/** True when the timeline has occurrences and every live one is over. */
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

/**
 * Short human proximity label for an upcoming anchor ("in 45 min", "Today",
 * "Tomorrow", "in 5 days"). Returns null for past/absent anchors — rows show
 * the absolute time regardless; this is the urgency accent next to it.
 */
export function getProximityLabel(
  anchor: Date | null,
  now = new Date(),
): string | null {
  if (!anchor) return null;
  const diffMs = anchor.getTime() - now.getTime();
  if (diffMs <= 0) return null;

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `in ${Math.max(diffMinutes, 1)} min`;

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Math.round, not floor: across a DST boundary a "day" between local
  // midnights is 23/25h and floor would undercount it.
  const dayDiff = Math.round(
    (new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate(),
    ).getTime() -
      todayStart.getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  if (dayDiff < 7) return `in ${dayDiff} days`;
  const weeks = Math.ceil(dayDiff / 7);
  return `in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}

export interface OccurrenceSourceAppointment {
  id: string;
  occurrences?: OccurrenceLike[] | null;
}

/** One OccurrenceVM per stored row, chronological — the timeline's input. */
export function occurrencesOfAppointment(
  appointment: OccurrenceSourceAppointment | null | undefined,
): OccurrenceVM[] {
  return sortOccurrences(
    (appointment?.occurrences ?? []).map((row) =>
      toOccurrenceVM({ ...row, appointmentId: appointment?.id ?? null }),
    ),
  );
}
