/**
 * The one writer of attendance: reads Stream's settled participant record for
 * an occurrence and stores it, once, as the room's MeetingPresence rows with
 * `Meeting.attendanceSettledAt`. The outcome sweep, the consultant no-show
 * detector, the rating gate and the ops re-read all call it; a snapshot is
 * immutable, so readiness is strict and anything short of a full read stores nothing.
 */
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import prisma from "@/lib/prisma";
import type { PresenceInterval } from "@/lib/booking/session-outcome";
import { resolveRoomEndsAt } from "@/lib/meetings/duration-cap";
import { readSettledAttendance } from "@/lib/stream/call-presence";

/** How long past the booked end a session Stream cannot answer for waits before the sweep parks it UNVERIFIED for ops. */
export const ATTENDANCE_SETTLE_WAIT_MS = 72 * 60 * 60 * 1000;

/** How long past the room's last known activity Stream's record is first read: time for late webhooks and lagging session stats to arrive. */
export const ATTENDANCE_SETTLE_DELAY_MS = 6 * 60 * 60 * 1000;

export interface SettleTarget {
  occurrenceId: string;
  endsAt: Date;
  meeting: {
    id: string;
    streamCallId: string;
    extendedSeconds: number;
    attendanceSettledAt: Date | null;
    endedAt: Date | null;
    endedReason: string | null;
    lastJoinedAt: Date | null;
    streamReportReadySessionIds: string[];
    lastStreamSessionId: string | null;
  };
}

/**
 * `settled` carries the stored rows; every other answer stored nothing and the
 * caller treats the session as undecided. `too-early`: the room's last known
 * activity is less than `ATTENDANCE_SETTLE_DELAY_MS` old, so a read now could miss a session.
 */
export type AttendanceSettlement =
  | { kind: "settled"; intervals: PresenceInterval[] }
  | { kind: "too-early" }
  | { kind: "not-final" }
  | { kind: "expired" }
  | { kind: "unavailable" };

/**
 * No settle reads Stream before this: `ATTENDANCE_SETTLE_DELAY_MS` after the
 * latest of the room end, the recorded end and the last join, so an overrun counts.
 */
export function attendanceReadableAt(target: SettleTarget): Date {
  const { meeting } = target;
  const lastActivity = Math.max(
    resolveRoomEndsAt(target.endsAt, meeting.extendedSeconds).getTime(),
    meeting.endedAt?.getTime() ?? 0,
    meeting.lastJoinedAt?.getTime() ?? 0,
  );
  return new Date(lastActivity + ATTENDANCE_SETTLE_DELAY_MS);
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

  const read = await readSettledAttendance({
    occurrenceId: target.occurrenceId,
    currentCallId: meeting.streamCallId,
    readySessionIds: meeting.streamReportReadySessionIds,
    lastKnownSessionId: meeting.lastStreamSessionId,
    // A pre-start end reserves a replacement id that no join may have created yet.
    currentCallReserved: meeting.endedReason === "ended_early",
    failures: opts.failures,
    deadlineAt: opts.deadlineAt,
  });
  if (read.kind !== "read" && read.kind !== "no-session") {
    return settledMeanwhile(meeting.id, read.kind);
  }
  // A session Stream ended more recently than the room knew of gets the same wait.
  if (
    read.kind === "read" &&
    read.lastSessionEndedAt &&
    now.getTime() <
      read.lastSessionEndedAt.getTime() + ATTENDANCE_SETTLE_DELAY_MS
  ) {
    return { kind: "too-early" };
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
  endedAt: true,
  endedReason: true,
  lastJoinedAt: true,
  streamReportReadySessionIds: true,
  lastStreamSessionId: true,
} as const;
