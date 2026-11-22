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

/** An empty session list is believed only this long past the booked end; right after a start it may be transient. */
export const EMPTY_RECORD_TRUSTED_AFTER_MS = 60 * 60 * 1000;

export interface SettleTarget {
  occurrenceId: string;
  endsAt: Date;
  meeting: {
    id: string;
    streamCallId: string;
    extendedSeconds: number;
    attendanceSettledAt: Date | null;
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
  opts: { now?: Date; failures?: RunFailureReporter } = {},
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
    failures: opts.failures,
  });
  if (read.kind === "no-session") {
    if (now.getTime() < target.endsAt.getTime() + EMPTY_RECORD_TRUSTED_AFTER_MS)
      return { kind: "too-early" };
  } else if (read.kind !== "read") {
    return { kind: read.kind };
  }
  const rows = read.kind === "read" ? read.intervals : [];

  await prisma.$transaction(async (tx) => {
    // The stamp first: a second settler that loses this compare-and-set writes nothing.
    const { count } = await tx.meeting.updateMany({
      where: { id: meeting.id, attendanceSettledAt: null },
      data: { attendanceSettledAt: now },
    });
    if (count === 0) return;
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
  });
  return { kind: "settled", intervals: await readStoredAttendance(meeting.id) };
}

/** The Meeting fields a settle needs, for callers' Prisma selects. */
export const SETTLE_MEETING_SELECT = {
  id: true,
  streamCallId: true,
  extendedSeconds: true,
  attendanceSettledAt: true,
} as const;
