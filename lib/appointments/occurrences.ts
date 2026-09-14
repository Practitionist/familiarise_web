/**
 * One `AppointmentOccurrence` row per held call (#1554).
 *
 * Before the reset a booking longer than 30 minutes was stored as N half-hour
 * rows and every reader grouped them back into "runs" (#1061). The row now
 * carries the real `endsAt`, so the grouping layer is gone: an occurrence IS
 * the session, the video room is keyed to it, and the join window is read off
 * its own bounds. The 30-minute unit survives only as the scheduling engine's
 * unit of arithmetic (`SCHEDULING_INTERVAL_MS`), which this module exposes so
 * an occurrence can still be expanded into the interval starts it covers.
 *
 * Writers (`buildOccurrence`, `buildOccurrenceForWindow`, `replaceOccurrence`)
 * and the join-state predicates share this file so the shape and its rules
 * cannot drift apart again. Who attends is never on the row: the roster is
 * `AppointmentParticipant` (lib/booking/participants.ts).
 */

import type { PrismaLike } from "@/lib/prisma";
import type { OccurrenceCompletionStatus, Prisma } from "@prisma/client";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
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

/**
 * Consultee join window (pre-start).
 *
 * #1270 — this and its consultant sibling are the ONLY two join windows in the
 * product. Six surfaces used to declare their own, landing on four different
 * answers, so the same booking opened at four different times depending on
 * which page the user happened to be looking at. Every caller imports one of
 * these two; nobody re-declares a literal.
 */
export const CONSULTEE_JOIN_WINDOW_MS = 10 * 60 * 1000;
/** Consultant join window (pre-start) — hosts get in earlier to set up. */
export const CONSULTANT_JOIN_WINDOW_MS = 15 * 60 * 1000;

export type OccurrenceJoinState =
  | "disabled"
  | "countdown"
  | "joinable"
  | "ended";

/**
 * Structural occurrence shape the join helpers accept. Deliberately looser
 * than `OccurrenceLike`: the join surfaces also hand us `lib/meeting`'s
 * `MeetingSlot` and planner rows, which carry no `completionStatus` and an
 * optional `isTentative`.
 */
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
    /**
     * #1270 — REQUIRED, not optional, and deliberately so. `isDeliberateEnd`
     * treats an absent reason as deliberate, which is the safe reading for a
     * historical row written before the column existed. But it is the WRONG
     * reading for a projection that simply forgot to select it: every
     * timed-out session would read as deliberately ended and lock people out
     * of their own booking, which is the bug this predicate exists to prevent.
     * Making it required means a query that omits it fails to compile instead.
     */
    endedReason: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export type OccurrenceInput = {
  startsAt: Date;
  durationInHours: number;
  consultantProfileId: string;
  isTentative?: boolean;
  /** 1-based position inside the appointment; defaults to 1 (a one-call booking). */
  ordinal?: number;
};

export type OccurrenceCreate = {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  consultantProfileId: string;
};

/**
 * Pure: one create payload for a call. The end is the start plus the whole
 * number of intervals the duration needs (`getSlotsPerCall` rounds a partial
 * interval UP), so a 45-minute booking still occupies the consultant's calendar
 * for the hour the engine reserved.
 */
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

/**
 * The same row, expressed as the [startsAt, endsAt) window the money paths
 * carry. #1319 — checkout and the webhook capture fallback both hold a session
 * as a start/end pair rather than a duration; one entry point so a future edit
 * cannot land on one writer and miss the other.
 */
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

/**
 * How many scheduling intervals a row COVERS. The engine's counts (the approval
 * gate, `getSlotsPerCall`) are in intervals, so a reader that compares them to
 * a row count would read every booking as one.
 */
export function intervalCountOf(occurrence: {
  startsAt: Date | string;
  endsAt: Date | string;
}): number {
  const start = new Date(occurrence.startsAt).getTime();
  const end = new Date(occurrence.endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    // A zero/negative-width row is malformed, not weightless: it is still one
    // row somebody has to reconcile, so it counts as the interval it occupies.
    return 1;
  }
  return Math.ceil((end - start) / SCHEDULING_INTERVAL_MS);
}

/** The interval STARTS a row covers — the shape the validator consumes. */
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
 * The next free ordinal on an appointment, for a genuinely NEW call (an
 * allocation top-up). A replacement after a reschedule inherits the replaced
 * row's ordinal instead; the live-row partial unique ignores dead rows.
 */
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

/**
 * Move the appointment's live occurrence to `startsAt` + duration (planner
 * Manage Timings and duration edits).
 *
 * In place, never delete + recreate: `Meeting` / `Recording` cascade on
 * occurrence delete, so a host who opened the room once would lose recordings
 * to a duration-only edit. The live row keeps its id (Stream room key), a
 * surplus live row (a legacy atom) is soft-retired RESCHEDULED, and a booking
 * with no live row gets one. Dead rows are left alone — they are not the live
 * call and must not donate their `startsAt` to a duration-only rewrite.
 */
export async function replaceOccurrence(
  // PrismaLike (not Prisma.TransactionClient): the app client is `$extends`,
  // and interactive-tx clients fail assignability against the bare generated
  // type (excessive stack depth / incompatible tx shape in CI).
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
    // The replacement keeps the position of the call it replaces: the row the
    // reschedule most recently released. Only a booking with no call at all
    // takes a new number.
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
    // #1569 — the earnings hold anchors on the call's end, which just moved.
    await recomputeEarningsHold(tx, args.appointmentId);
    return { occurrenceId: created.id };
  }

  // `occurrence_no_confirmed_overlap` is NOT DEFERRABLE and checks each UPDATE
  // against sibling rows still holding their old times, so a legacy multi-row
  // booking is flipped tentative first; the kept row is restored below.
  if (live.length > 1) {
    await tx.appointmentOccurrence.updateMany({
      where: { id: { in: live.map((row) => row.id) } },
      data: { isTentative: true },
    });
  }
  const [kept, ...surplus] = live;
  await tx.appointmentOccurrence.update({
    where: { id: kept.id },
    data: {
      startsAt: target.startsAt,
      endsAt: target.endsAt,
      isTentative: target.isTentative,
      consultantProfileId: target.consultantProfileId,
    },
  });
  // Soft-retire, never delete: history and Stream children stay queryable.
  for (const row of surplus) {
    await tx.appointmentOccurrence.update({
      where: { id: row.id },
      data: { isTentative: true, completionStatus: "RESCHEDULED" },
    });
  }
  await recomputeEarningsHold(tx, args.appointmentId);
  return { occurrenceId: kept.id };
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

// A mutable array: Prisma's `notIn` rejects a readonly tuple.
const DEAD_COMPLETION_STATUS_LIST: OccurrenceCompletionStatus[] = [
  "CANCELLED",
  "RESCHEDULED",
];
const DEAD_COMPLETION_STATUSES = new Set<string>(DEAD_COMPLETION_STATUS_LIST);

/**
 * Prisma `where` twin of `isDeadOccurrence` — a live row on the appointment.
 * A reschedule releases a row IN PLACE (`isTentative: true` + RESCHEDULED),
 * so any `isTentative` filter that omits this re-selects or resurrects it
 * (FAMILIARISE_WEB-46).
 */
export const liveOccurrenceWhere = {
  deletedAt: null,
  completionStatus: { notIn: DEAD_COMPLETION_STATUS_LIST },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/**
 * Non-live for planner rewrites and join math.
 *
 * `completionStatus` alone used to be enough, but A10 also soft-deletes via
 * `deletedAt`. A tombstoned row with a still-"SCHEDULED" status would otherwise
 * count as live. Treat either signal as dead.
 */
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

/**
 * Occurrence-derived half of "may this booking be rescheduled".
 *
 * The status, role and route checks genuinely differ per side and stay with
 * their adapter. These three do not, and they drifted: the consultant's menu
 * offered Reschedule on a booking with nothing allocated and on one already
 * awaiting a new time, both of which the API then rejects.
 */
export function occurrencesAllowReschedule(
  occurrences: Array<{
    isTentative?: boolean | null;
    completionStatus?: string | null;
  }>,
): boolean {
  // An APPROVED booking with nothing allocated ("Not scheduled · 0/0") has no
  // time to move, and the proposal window is derived from the earliest released
  // occurrence — so this fails with PROPOSAL_WINDOW_CLOSED rather than opening
  // an empty picker.
  if (occurrences.length === 0) return false;
  // Tentative means the request is still awaiting allocation, not booked.
  if (occurrences[0]?.isTentative) return false;
  // A released occurrence awaiting a new time IS the open reschedule: at most
  // one may be live per appointment (the nullable-unique openForAppointmentId,
  // claimed by preference-only rows too — #1065), so offering the action again
  // only earns a 409.
  return !occurrences.some((row) => row.completionStatus === "RESCHEDULED");
}

/**
 * Whether Manage Timings may be offered at all — the menu item AND the page,
 * since that URL is linkable (#1082).
 *
 * Manage Timings writes new times straight onto the calendar: no notice
 * requirement, no acceptance from anyone. That is honest only while nobody
 * else has committed to a time, so the deciding question is whether a
 * counterparty already holds one — not who owns the calendar.
 *
 * The exact complement of `occurrencesAllowReschedule` for the surfaces that
 * offer both, so a consultant is never handed the unilateral surface and the
 * negotiated one for the same booking.
 */
export function allowsManageTimings(
  kind: AppointmentKind,
  occurrences: Array<{ isTentative?: boolean | null }>,
): boolean {
  // A webinar or class is a published schedule attendees buy into rather than
  // a time anyone negotiated, so the organiser keeps this surface even once
  // the instance is confirmed — there is no single counterparty to propose to,
  // and asking every attendee to accept is not a coherent flow.
  if (kind === "WEBINAR" || kind === "CLASS") return true;
  // Nothing placed: an offering that was never scheduled, or a booking whose
  // calls are not allocated yet. Still the consultant's own calendar.
  if (occurrences.length === 0) return true;
  // EVERY upcoming occurrence, not just the earliest. A partial reschedule
  // releases one call of a multi-call booking and leaves the rest confirmed,
  // so the first row chronologically can be the released one while a consultee
  // still holds a committed time later in the same booking.
  return occurrences.every((row) => Boolean(row.isTentative));
}

/**
 * Whether Unschedule may be offered — pulling a placed group event off the
 * calendar and back into the allocate queue, without cancelling it (#1082).
 *
 * Orthogonal to the Timings/Reschedule pair rather than a third branch of it.
 * A confirmed webinar offers Timings AND this; a 1:1 never offers it, because
 * releasing a time a counterparty holds is the negotiation Reschedule already
 * runs. It is emphatically NOT Cancel: the booking stays sold, attendees stay
 * enrolled, and no money, earnings or ledger row moves.
 */
export function allowsUnschedule(
  kind: AppointmentKind,
  occurrences: Array<{ isTentative?: boolean | null }>,
): boolean {
  if (kind !== "WEBINAR" && kind !== "CLASS") return false;
  // Nothing placed yet — an offering that was never scheduled, or one already
  // unscheduled (the release leaves every row tentative). No date to withdraw,
  // and Timings is the surface for setting one.
  return occurrences.some((row) => !row.isTentative);
}

/**
 * The occurrences a time-change decision acts on: still ahead of now,
 * chronological. A finished call is not what "has someone committed to a time"
 * is asking about, and the first entry has to be the earliest for the
 * tentative test.
 */
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

/**
 * Reasons a call is over FOR GOOD, as opposed to merely not currently live.
 *
 * #1270 — every gate used to read `endedAt` alone, and `endedAt` is written by
 * four different things. Stream fires `call.session_ended` after
 * `inactivity_timeout_seconds` (900s on the live call type) once the LAST
 * participant leaves, which stamps `session_timeout`. So both people in a 1:1
 * losing signal for that long — a wifi handoff, a tunnel, a closed lid —
 * ended their paid consultation permanently, for both of them, mid-session.
 * The reconciler's guesses (`reconciled_no_end`, `stream_not_found`) had the
 * same effect, and so did a host pressing "End for everyone" during the
 * pre-start device check — now stamped `ended_early`, which is not deliberate:
 * the next participant join clears it (#1607).
 *
 * A deliberate end is the host closing the room, or maintenance draining it.
 * Everything else means "nobody is in there right now", which is a very
 * different question from "you may not come back".
 */
const DELIBERATE_END_REASONS = new Set(["call_ended", "maintenance"]);

export function isDeliberateEnd(
  session?: {
    endedAt: Date | string | null;
    endedReason?: string | null;
  } | null,
): boolean {
  if (!session?.endedAt) return false;
  // A row with no reason predates the reason column; treat it as deliberate,
  // which is the conservative reading for historical data.
  return session.endedReason
    ? DELIBERATE_END_REASONS.has(session.endedReason)
    : true;
}

/** Join state of one occurrence, evaluated over its own [startsAt, endsAt]. */
export function getOccurrenceJoinState(
  occurrence: JoinableOccurrence,
  opts?: { joinWindowMs?: number; now?: Date },
): OccurrenceJoinState {
  if (occurrence.isTentative) return "disabled";
  if (isDeadOccurrence(occurrence)) return "disabled";
  // The host closed the room (or maintenance drained it).
  if (isDeliberateEnd(occurrence.meeting)) return "ended";

  const joinWindowMs = opts?.joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const now = (opts?.now ?? new Date()).getTime();
  const { start, end } = occurrenceTimes(occurrence);

  if (now > end) return "ended";
  if (now >= start - joinWindowMs) return "joinable";
  return "countdown";
}

/** Live occurrences, chronological. */
export function liveOccurrencesOf<T extends JoinableOccurrence>(
  occurrences: T[],
): T[] {
  return occurrences
    .filter((row) => !isDeadOccurrence(row))
    .sort((a, b) => occurrenceTimes(a).start - occurrenceTimes(b).start);
}

/**
 * Earliest occurrence currently inside its join window, or null — the row the
 * Stream call is keyed to, handed straight to `getOrCreateAppointmentMeeting`.
 */
export function getJoinableOccurrence<T extends JoinableOccurrence>(
  occurrences: T[],
  opts?: { joinWindowMs?: number; now?: Date },
): T | null {
  for (const row of liveOccurrencesOf(occurrences)) {
    if (getOccurrenceJoinState(row, opts) === "joinable") return row;
  }
  return null;
}

/**
 * The occurrence that is live or next up, else the most recent past one. Used
 * by surfaces that must render *a* call even outside the join window.
 */
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

/**
 * Join state for a mapper-emitted `OccurrenceVM`. It exists because the
 * timeline used to answer "is this joinable?" from the clock alone and
 * therefore could not see a call the host had already ended (#1270).
 */
export function getOccurrenceVMJoinState(
  occurrence: OccurrenceVM,
  opts?: { joinWindowMs?: number; now?: Date },
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
    opts,
  );
}

/**
 * When the host closed the room (or maintenance drained it), else null. An
 * inactivity timeout or a pre-start `ended_early` is not the call's end: the
 * gates re-admit, so the buckets and the timeline must not call it over
 * (#1607).
 */
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
