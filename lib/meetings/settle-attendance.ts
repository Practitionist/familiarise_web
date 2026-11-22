/**
 * The one writer of attendance: reads Stream's settled participant record for
 * an occurrence and stores it, once, as the room's MeetingPresence rows with
 * `Meeting.attendanceSettledAt`. The outcome sweep, the consultant no-show
 * detector, the rating gate and the ops re-read all call it; a snapshot is
 * immutable, so readiness is strict and anything short of a full read stores nothing.
 */
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import prisma from "@/lib/prisma";
import { REJOIN_GRACE_MS } from "@/lib/appointments/occurrences";
import type { PresenceInterval } from "@/lib/booking/session-outcome";
import { resolveRoomEndsAt } from "@/lib/meetings/duration-cap";
import { readSettledAttendance } from "@/lib/stream/call-presence";

/** How long past the booked end a session Stream cannot answer for waits before the sweep parks it UNVERIFIED for ops. */
export const ATTENDANCE_SETTLE_WAIT_MS = 72 * 60 * 60 * 1000;

/**
 * How long past the room end a session with no `call.stats_report_ready` is
 * read anyway, if our webhooks or the call corroborate the session list; an
 * empty record is believed only from then too.
 */
export const REPORT_READY_FALLBACK_MS = 6 * 60 * 60 * 1000;

export interface SettleTarget {
  occurrenceId: string;
  /** The booked start: before the fallback, an announced session must have ended after it. */
  startsAt: Date;
  endsAt: Date;
  meeting: {
    id: string;
    streamCallId: string;
    extendedSeconds: number;
    attendanceSettledAt: Date | null;
    endedReason: string | null;
    streamReportReadySessionIds: string[];
    lastStreamSessionId: string | null;
  };
}

/**
 * `settled` carries the stored rows; every other answer stored nothing and the
 * caller treats the session as undecided. `too-early`: the room can still be
 * rejoined or reopened, so a read now could miss a later session.
 */
export type AttendanceSettlement =
  | { kind: "settled"; intervals: PresenceInterval[] }
  | { kind: "too-early" }
  | { kind: "not-final" }
  | { kind: "expired" }
  | { kind: "unavailable" };

/** After this nobody can join or reopen the room, so Stream's record can only be final. */
export function attendanceReadableAt(target: SettleTarget): Date {
  const roomEndsAt = resolveRoomEndsAt(
    target.endsAt,
    target.meeting.extendedSeconds,
  );
  return new Date(roomEndsAt.getTime() + REJOIN_GRACE_MS);
}

function readStoredAttendance(meetingId: string): Promise<PresenceInterval[]> {
  return prisma.meetingPresence.findMany({
    where: { meetingId },
    select: { userId: true, joinedAt: true, leftAt: true },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  });
}

/** Idempotent: a settled room answers its stored rows without asking Stream again. */
export async function settleOccurrenceAttendance(
  target: SettleTarget,
  opts: {
    now?: Date;
    failures?: RunFailureReporter;
    /** Epoch ms by which every Stream request must answer; past it nothing is stored. */
    deadlineAt?: number;
  } = {},
): Promise<AttendanceSettlement> {
  const now = opts.now ?? new Date();
  const { meeting } = target;
  if (meeting.attendanceSettledAt) {
    return {
      kind: "settled",
      intervals: await readStoredAttendance(meeting.id),
    };
  }
  if (now < attendanceReadableAt(target)) return { kind: "too-early" };

  const fallback =
    now.getTime() >=
    resolveRoomEndsAt(target.endsAt, meeting.extendedSeconds).getTime() +
      REPORT_READY_FALLBACK_MS;
  const read = await readSettledAttendance({
    occurrenceId: target.occurrenceId,
    currentCallId: meeting.streamCallId,
    readySessionIds: meeting.streamReportReadySessionIds,
    bookedStartsAt: target.startsAt,
    lastKnownSessionId: meeting.lastStreamSessionId,
    fallback,
    // A pre-start end reserves a replacement id that no join may have created yet.
    currentCallReserved: meeting.endedReason === "ended_early",
    failures: opts.failures,
    deadlineAt: opts.deadlineAt,
  });
  if (read.kind === "no-session") {
    // No session can announce a ready report, so an empty record waits for the fallback.
    if (!fallback) return { kind: "too-early" };
  } else if (read.kind !== "read") {
    return settledMeanwhile(meeting.id, read.kind);
  }
  const rows = read.kind === "read" ? read.intervals : [];

  const stamped = await prisma.$transaction(async (tx) => {
    // The stamp first, on the room exactly as read: a second settler, or a room rotated,
    // extended or told of a new session since the read, makes this compare-and-set miss and writes nothing.
    const { count } = await tx.meeting.updateMany({
      where: {
        id: meeting.id,
        attendanceSettledAt: null,
        streamCallId: meeting.streamCallId,
        extendedSeconds: meeting.extendedSeconds,
        // A session announced or seen since the read could be missing from it.
        lastStreamSessionId: meeting.lastStreamSessionId,
        streamReportReadySessionIds: {
          equals: meeting.streamReportReadySessionIds,
        },
      },
      data: { attendanceSettledAt: now },
    });
    if (count === 0) return false;
    // Rows stored before the room settled are not Stream's record; the snapshot replaces them.
    await tx.meetingPresence.deleteMany({ where: { meetingId: meeting.id } });
    if (rows.length === 0) return;
    await tx.meetingPresence.createMany({
      data: rows.map((row) => ({
        meetingId: meeting.id,
        appointmentOccurrenceId: target.occurrenceId,
        userId: row.userId,
        userSessionId: row.userSessionId,
        streamCallId: row.streamCallId,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      })),
      skipDuplicates: true,
    });
    return true;
  });
  if (!stamped) return settleAfterLostStamp(target, now);
  return { kind: "settled", intervals: await readStoredAttendance(meeting.id) };
}

/** A read that could not settle still answers a snapshot another settler stored meanwhile. */
async function settledMeanwhile(
  meetingId: string,
  kind: "not-final" | "expired" | "unavailable",
): Promise<AttendanceSettlement> {
  const room = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { attendanceSettledAt: true },
  });
  return room?.attendanceSettledAt
    ? { kind: "settled", intervals: await readStoredAttendance(meetingId) }
    : { kind };
}

/** A missed stamp is another settler's snapshot, or a room that changed since the read: judge the room afresh. */
async function settleAfterLostStamp(
  target: SettleTarget,
  now: Date,
): Promise<AttendanceSettlement> {
  const fresh = await prisma.meeting.findUnique({
    where: { id: target.meeting.id },
    select: SETTLE_MEETING_SELECT,
  });
  if (!fresh) return { kind: "unavailable" };
  if (fresh.attendanceSettledAt) {
    return { kind: "settled", intervals: await readStoredAttendance(fresh.id) };
  }
  // The room moved under the read; the next run reads it again from its current state.
  return now < attendanceReadableAt({ ...target, meeting: fresh })
    ? { kind: "too-early" }
    : { kind: "not-final" };
}

/** The Meeting fields a settle needs, for callers' Prisma selects. */
export const SETTLE_MEETING_SELECT = {
  id: true,
  streamCallId: true,
  extendedSeconds: true,
  attendanceSettledAt: true,
  endedReason: true,
  streamReportReadySessionIds: true,
  lastStreamSessionId: true,
} as const;
