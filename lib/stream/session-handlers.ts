/**
 * Stream Session Event Handlers
 * Handles webhook events for call lifecycle (session start/end)
 *
 * Events handled:
 * - call.session_ended: When call session ends (last participant leaves + timeout)
 * - call.ended: When call is explicitly ended
 *
 * #1569 D2 — these stamp Meeting.endedAt only. The end + 1 h slot pass in
 * auto-complete-appointments is the one writer of an occurrence's outcome.
 */

import prisma, { type Tx } from "@/lib/prisma";
import { isDeliberateEnd } from "@/lib/appointments/occurrences";
import {
  END_REASON_POLICY,
  endBlocksRejoin,
  mapStreamCallEndedReason,
  recordedEndHolds,
  type MeetingEndReason,
} from "@/lib/meetings/end-reasons";
import { parseSlotIdFromCallId, toCallId } from "@/lib/stream/call-cid";
import { getCallParticipantSessionsFromStream } from "@/lib/stream/call-presence";
import {
  closeSegmentPresences,
  findStayAfterEnd,
} from "@/lib/meetings/segment-presence";
import { streamLogger } from "@/lib/stream-logger";

export interface StreamSessionEndedEvent {
  call_cid: string;
  type: "call.session_ended";
  created_at: string;
  /** The Stream session that ended; a later session of the same call has its own id. */
  session_id?: string;
  call?: {
    id: string;
    type: string;
    created_by_user_id?: string;
  };
}

export interface StreamCallEndedEvent {
  call_cid: string;
  type: "call.ended";
  created_at: string;
  call?: {
    id: string;
    type: string;
    created_by_user_id?: string | null;
    ended_by_user_id?: string | null;
    session?: { id: string } | null;
  };
  user?: {
    id: string;
    [key: string]: unknown;
  } | null;
  reason?: string | null;
  ended_by_user_id?: string | null;
}

export interface StreamSessionParticipantJoinedEvent {
  call_cid: string;
  type: "call.session_participant_joined";
  created_at: string;
  session_id: string;
  participant: {
    user: { id: string };
    user_session_id?: string;
    role?: string;
  };
}

export interface StreamSessionParticipantLeftEvent {
  call_cid: string;
  type: "call.session_participant_left";
  created_at: string;
  session_id: string;
  duration_seconds?: number;
  participant: {
    user: { id: string };
    user_session_id?: string;
    role?: string;
  };
}

export function extractEndedByUserId(
  event: StreamCallEndedEvent,
): string | null {
  return (
    event.user?.id ??
    event.call?.ended_by_user_id ??
    event.ended_by_user_id ??
    null
  );
}

const MEETING_END_INCLUDE = {
  occurrence: {
    include: {
      appointment: {
        select: {
          webinar: { select: { id: true } },
          class: { select: { id: true } },
        },
      },
    },
  },
} as const;

type GroupSessionCandidate = {
  occurrence?: {
    appointment?: {
      webinar?: unknown;
      class?: unknown;
    } | null;
  } | null;
};

function summarizeParticipantIntervals(
  intervals: Array<{ userId: string; joinedAt: Date; leftAt: Date | null }>,
  endedAt: Date,
): Map<string, { firstJoinedAt: Date; lastLeftAt: Date; count: number }> {
  const summaryByUser = new Map<
    string,
    { firstJoinedAt: Date; lastLeftAt: Date; count: number }
  >();
  for (const interval of intervals) {
    const effectiveLeft = interval.leftAt ?? endedAt;
    const existing = summaryByUser.get(interval.userId);
    if (!existing) {
      summaryByUser.set(interval.userId, {
        firstJoinedAt: interval.joinedAt,
        lastLeftAt: effectiveLeft,
        count: 1,
      });
      continue;
    }
    if (interval.joinedAt < existing.firstJoinedAt) {
      existing.firstJoinedAt = interval.joinedAt;
    }
    if (effectiveLeft > existing.lastLeftAt) {
      existing.lastLeftAt = effectiveLeft;
    }
    existing.count += 1;
  }
  return summaryByUser;
}

/**
 * Backfills webinar/class presence and attendance rows missed during end-of-call bursts, from the
 * ended Stream session only; a stay that began after the end belongs to a later session and is left out.
 */
export async function reconcileWebinarAttendance(
  meeting: {
    id: string;
    streamCallId: string;
    appointmentOccurrenceId: string;
  } & GroupSessionCandidate,
  endedAt: Date,
  sessionId: string | null,
): Promise<void> {
  const slotOfAppointment = meeting.occurrence?.appointment;
  if (!slotOfAppointment?.webinar && !slotOfAppointment?.class) {
    return;
  }

  const reported = await getCallParticipantSessionsFromStream(
    meeting.streamCallId,
    sessionId,
  );
  const intervals = reported?.filter((i) => i.joinedAt <= endedAt);
  if (!intervals?.length) return;

  const summaryByUser = summarizeParticipantIntervals(intervals, endedAt);

  await prisma.$transaction(async (tx) => {
    await tx.meetingPresence.createMany({
      data: intervals.map((interval) => ({
        meetingId: meeting.id,
        appointmentOccurrenceId: meeting.appointmentOccurrenceId,
        userId: interval.userId,
        userSessionId: interval.userSessionId,
        streamCallId: meeting.streamCallId,
        joinedAt: interval.joinedAt,
        leftAt: interval.leftAt ?? endedAt,
        closedByEnd: interval.leftAt === null,
      })),
      skipDuplicates: true,
    });

    for (const [userId, summary] of summaryByUser) {
      await tx.meetingAttendance.upsert({
        where: {
          meetingId_userId: { meetingId: meeting.id, userId },
        },
        create: {
          meetingId: meeting.id,
          appointmentOccurrenceId: meeting.appointmentOccurrenceId,
          userId,
          firstJoinedAt: summary.firstJoinedAt,
          lastLeftAt: summary.lastLeftAt,
          joinCount: summary.count,
        },
        update: {},
      });
      await tx.meetingAttendance.updateMany({
        where: {
          meetingId: meeting.id,
          userId,
          firstJoinedAt: { gt: summary.firstJoinedAt },
        },
        data: { firstJoinedAt: summary.firstJoinedAt },
      });
      await tx.meetingAttendance.updateMany({
        where: {
          meetingId: meeting.id,
          userId,
          OR: [
            { lastLeftAt: null },
            { lastLeftAt: { lt: summary.lastLeftAt } },
          ],
        },
        data: { lastLeftAt: summary.lastLeftAt },
      });
    }
  });
}

async function runBestEffortGroupReconciliation(
  meeting: {
    id: string;
    streamCallId: string;
    appointmentOccurrenceId: string;
  } & GroupSessionCandidate,
  endedAt: Date,
  sessionId: string | null,
): Promise<void> {
  try {
    await reconcileWebinarAttendance(meeting, endedAt, sessionId);
  } catch (reconcileErr) {
    streamLogger.warn(
      "Webinar attendance backfill failed; end stamp preserved",
      {
        meetingId: meeting.id,
        sessionId: meeting.id,
        streamCallId: meeting.streamCallId,
        error:
          reconcileErr instanceof Error
            ? reconcileErr.message
            : String(reconcileErr),
      },
    );
  }
}

export async function handleSessionEnded(
  event: StreamSessionEndedEvent,
): Promise<void> {
  const { call_cid, created_at } = event;
  const endedSessionId = event.session_id ?? null;
  const streamCallId = toCallId(call_cid);

  streamLogger.info("Session ended", {
    streamCallId,
    endedAt: created_at,
  });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
      include: MEETING_END_INCLUDE,
    });

    if (!meeting) {
      streamLogger.warn("Meeting session not found for session ended event", {
        streamCallId,
      });
      return;
    }

    const endedAt = new Date(created_at);

    if (!endSupersedes(meeting, "session_timeout", endedAt)) {
      await runBestEffortGroupReconciliation(
        meeting,
        meeting.endedAt ?? endedAt,
        endedSessionId,
      );
      streamLogger.info("Stale end event — a later end is already recorded", {
        sessionId: meeting.id,
        streamCallId,
        previousEndedAt: meeting.endedAt,
      });
      return;
    }

    const slotEndsAt = meeting.occurrence.endsAt;
    const bookedTimeIsOver = !slotEndsAt || endedAt >= new Date(slotEndsAt);

    const stamped = await stampEnd(meeting, endedAt, "session_timeout");
    if (!stamped) return;

    await runBestEffortGroupReconciliation(meeting, endedAt, endedSessionId);

    if (!bookedTimeIsOver) {
      streamLogger.info(
        "Stream session ended before the booked window closed — slot left open",
        {
          sessionId: meeting.id,
          streamCallId,
          endedAt: endedAt.toISOString(),
          slotEndsAt: slotEndsAt ? new Date(slotEndsAt).toISOString() : null,
        },
      );
    }

    const slotStartTime = meeting.occurrence.startsAt;
    if (slotStartTime) {
      const durationMinutes = Math.round(
        (endedAt.getTime() - new Date(slotStartTime).getTime()) / (1000 * 60),
      );
      streamLogger.info("Session duration calculated", {
        sessionId: meeting.id,
        durationMinutes,
      });
    }

    streamLogger.info("Meeting session updated - session ended", {
      sessionId: meeting.id,
      streamCallId,
      endedAt: created_at,
      endedReason: "session_timeout",
    });
  } catch (error) {
    streamLogger.error("Failed to handle session ended event", error, {
      streamCallId,
    });
    throw error;
  }
}

export async function handleCallEnded(
  event: StreamCallEndedEvent,
): Promise<void> {
  const { call_cid, created_at } = event;
  const endedSessionId = event.call?.session?.id ?? null;
  const endedByUserId = extractEndedByUserId(event);
  const hasEndedByUser = Boolean(endedByUserId);
  const streamCallId = toCallId(call_cid);

  streamLogger.info("Call ended", {
    streamCallId,
    endedAt: created_at,
    hasEndedByUser,
  });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
      include: MEETING_END_INCLUDE,
    });

    if (!meeting) {
      streamLogger.warn("Meeting session not found for call ended event", {
        streamCallId,
      });
      return;
    }

    const endedAt = new Date(created_at);
    const slotStartsAt = meeting.occurrence.startsAt;
    const endedBeforeStart = !!slotStartsAt && endedAt < new Date(slotStartsAt);
    const endedReason = mapStreamCallEndedReason({
      endedBeforeStart,
      endedByUserId,
      streamReason: event.reason,
    });

    if (!endSupersedes(meeting, endedReason, endedAt)) {
      await runBestEffortGroupReconciliation(
        meeting,
        meeting.endedAt ?? endedAt,
        endedSessionId,
      );
      streamLogger.info("Stale end event — a later end is already recorded", {
        sessionId: meeting.id,
        streamCallId,
        previousEndedAt: meeting.endedAt,
      });
      return;
    }

    if (!(await stampEnd(meeting, endedAt, endedReason))) return;

    await runBestEffortGroupReconciliation(meeting, endedAt, endedSessionId);

    const slotStartTime = meeting.occurrence.startsAt;
    if (slotStartTime) {
      const durationMinutes = Math.round(
        (endedAt.getTime() - new Date(slotStartTime).getTime()) / (1000 * 60),
      );
      streamLogger.info("Session duration calculated", {
        sessionId: meeting.id,
        durationMinutes,
        hasEndedByUser,
      });
    }

    streamLogger.info("Meeting session updated - call ended", {
      sessionId: meeting.id,
      streamCallId,
      endedAt: created_at,
      endedReason,
      streamReason: event.reason ?? null,
      hasEndedByUser,
    });
  } catch (error) {
    streamLogger.error("Failed to handle call ended event", error, {
      streamCallId,
    });
    throw error;
  }
}

type SynchronousEndResult =
  | { kind: "not_found" }
  | { kind: "already_ended"; streamCallId: string }
  | {
      kind: "recorded";
      endedReason: "ended_early" | "call_ended";
      streamCallId: string;
    };

/**
 * Stamps `Meeting.endedAt` and `endedReason` on a host's end before the webhook
 * lands; `streamCallId` is the id that now represents the room.
 */
export async function recordMeetingEndedSynchronously(
  streamCallId: string,
  endedAt: Date = new Date(),
): Promise<SynchronousEndResult> {
  const meeting = await prisma.meeting.findUnique({
    where: { streamCallId },
    include: { occurrence: true },
  });
  if (!meeting) return { kind: "not_found" };

  const alreadyEnded = {
    kind: "already_ended" as const,
    streamCallId: meeting.streamCallId,
  };
  const slotStartsAt = meeting.occurrence.startsAt;
  const endedBeforeStart = !!slotStartsAt && endedAt < new Date(slotStartsAt);
  const endedReason = endedBeforeStart ? "ended_early" : "call_ended";

  if (!endSupersedes(meeting, endedReason, endedAt)) return alreadyEnded;

  if (endedBeforeStart) {
    const nextStreamCallId = `occurrence-${meeting.occurrence.id}-r${endedAt.getTime().toString(36)}`;
    // The rotated-away segment closes its presence and attendance like any other end.
    const rotated = await prisma.$transaction(async (tx) => {
      const updated = await tx.meeting.updateMany({
        where: {
          id: meeting.id,
          streamCallId: meeting.streamCallId,
          endedAt: meeting.endedAt,
          endedReason: meeting.endedReason,
        },
        data: {
          endedAt,
          endedReason,
          streamCallId: nextStreamCallId,
          isRecording: false,
        },
      });
      if (updated.count === 0) return false;
      await closeSegmentAttendance(tx, meeting, endedAt);
      return true;
    });
    if (!rotated) return alreadyEnded;
    return { kind: "recorded", endedReason, streamCallId: nextStreamCallId };
  }

  if (!(await stampEnd(meeting, endedAt, endedReason))) return alreadyEnded;
  return { kind: "recorded", endedReason, streamCallId: meeting.streamCallId };
}

/**
 * Resolve the Meeting for a Stream call_cid (format "type:callId").
 * Returns null (not throw) when no session matches — Stream emits participant
 * events for ad-hoc calls that may never have been persisted; those are skipped.
 */
async function resolveMeeting(streamCallId: string) {
  const select = {
    id: true,
    endedAt: true,
    endedReason: true,
    appointmentOccurrenceId: true,
  } as const;

  const direct = await prisma.meeting.findUnique({
    where: { streamCallId },
    select,
  });
  if (direct) return { meeting: direct, isCurrentSegment: true };

  // A prior segment of the same occurrence (before a reopen or rotation): its rows keep their own call id.
  const occurrenceId = parseSlotIdFromCallId(streamCallId);
  if (!occurrenceId) return null;

  const prior = await prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: occurrenceId },
    select,
  });
  return prior ? { meeting: prior, isCurrentSegment: false } : null;
}

function presenceKey(
  sessionId: string,
  participant: { user_session_id?: string },
  userId: string,
): string {
  return participant.user_session_id || `${sessionId}:${userId}`;
}

/** Closes the segment's open presence (as assumed) and the meeting's open attendance at its end stamp. */
async function closeSegmentAttendance(
  tx: Tx,
  meeting: { id: string; streamCallId: string },
  endedAt: Date,
): Promise<void> {
  await closeSegmentPresences(tx, {
    meetingId: meeting.id,
    streamCallId: meeting.streamCallId,
    endedAt,
  });
  await tx.meetingAttendance.updateMany({
    where: { meetingId: meeting.id, lastLeftAt: null },
    data: { lastLeftAt: endedAt },
  });
}

/**
 * Row lock on the room, taken first by every current-room join and non-deliberate end so each
 * sees the other's commit. NO KEY UPDATE leaves the presence and attendance foreign-key checks free.
 */
async function lockMeetingRow(tx: Tx, meetingId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Meeting" WHERE id = ${meetingId} FOR NO KEY UPDATE`;
}

type RecordedEnd = { endedAt: Date | null; endedReason: string | null };

/** Stamps the end on the room's current segment, compare-and-set on the end (stamp and reason) the caller read. */
function casEnd(
  tx: Tx,
  meeting: { id: string; streamCallId: string },
  expected: RecordedEnd,
  endedAt: Date,
  endedReason: MeetingEndReason,
) {
  return tx.meeting.updateMany({
    where: {
      id: meeting.id,
      streamCallId: meeting.streamCallId,
      endedAt: expected.endedAt,
      endedReason: expected.endedReason,
    },
    data: { endedAt, endedReason, isRecording: false },
  });
}

function stampEnd(
  meeting: { id: string; streamCallId: string } & RecordedEnd,
  endedAt: Date,
  endedReason: MeetingEndReason,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // A join after a non-deliberate end reopens the room, so a stay that joined after this end means a newer session owns it.
    if (!END_REASON_POLICY[endedReason].deliberate) {
      await lockMeetingRow(tx, meeting.id);
      const newer = await findStayAfterEnd(tx, {
        meetingId: meeting.id,
        streamCallId: meeting.streamCallId,
        endedAt,
      });
      if (newer) {
        streamLogger.info("End not stamped — a newer session owns the room", {
          sessionId: meeting.id,
          endedReason,
        });
        return false;
      }
    }
    let { count } = await casEnd(tx, meeting, meeting, endedAt, endedReason);
    if (count === 0) {
      // Another end committed first: re-decide against it, on the same segment only.
      const room = await tx.meeting.findUnique({
        where: { id: meeting.id },
        select: { streamCallId: true, endedAt: true, endedReason: true },
      });
      if (
        room?.streamCallId === meeting.streamCallId &&
        endSupersedes(room, endedReason, endedAt)
      ) {
        ({ count } = await casEnd(tx, meeting, room, endedAt, endedReason));
      }
    }
    if (count === 0) {
      streamLogger.info(
        "End not stamped — the room's end changed concurrently",
        {
          sessionId: meeting.id,
        },
      );
      return false;
    }
    await closeSegmentAttendance(tx, meeting, endedAt);
    return true;
  });
}

/**
 * A leave reported after the current room ended is clamped to that end, unless the
 * device joined after it (a rejoin the join webhook has not reopened yet).
 */
function clampLeaveToRoomEnd(
  meeting: { endedAt: Date | null; endedReason: string | null },
  joinedAt: Date,
  leftAt: Date,
): Date {
  const { endedAt } = meeting;
  if (!endedAt || leftAt <= endedAt) return leftAt;
  return endBlocksRejoin(meeting) || joinedAt <= endedAt ? endedAt : leftAt;
}

/** True when an incoming end replaces the recorded one: a deliberate end beats a non-deliberate one whatever their stamps; otherwise the later end wins. */
function endSupersedes(
  recorded: { endedAt: Date | null; endedReason: string | null },
  incoming: MeetingEndReason,
  incomingAt: Date,
): boolean {
  if (!recorded.endedAt) return true;
  if (recordedEndHolds(recorded, incoming)) return false;
  if (END_REASON_POLICY[incoming].deliberate) return true;
  return incomingAt.getTime() > recorded.endedAt.getTime();
}

type JoinRoom = { current: boolean; endedAt: Date | null };

const PRIOR_SEGMENT: JoinRoom = { current: false, endedAt: null };

/**
 * Re-reads the room under its row lock and reopens a non-deliberate end the join postdates.
 * A room rotated off the join's call id since it was resolved makes the join a prior segment's.
 */
async function settleRoomForJoin(
  tx: Tx,
  meetingId: string,
  streamCallId: string,
  joinedAt: Date,
): Promise<JoinRoom> {
  await lockMeetingRow(tx, meetingId);
  const room = await tx.meeting.findUnique({
    where: { id: meetingId },
    select: { streamCallId: true, endedAt: true, endedReason: true },
  });
  if (room?.streamCallId !== streamCallId) return PRIOR_SEGMENT;
  if (!room.endedAt) return { current: true, endedAt: null };
  if (joinedAt <= room.endedAt || isDeliberateEnd(room)) {
    return { current: true, endedAt: room.endedAt };
  }
  const reopened = await tx.meeting.updateMany({
    where: { id: meetingId, endedAt: room.endedAt },
    data: { endedAt: null, endedReason: null },
  });
  return { current: true, endedAt: reopened.count > 0 ? null : room.endedAt };
}

/** `inCurrentRoom`: the join is to the live current segment; `repairedStay`: it reopened its own wrongly closed device row. */
function buildAttendanceJoinUpdate(
  newSessions: number,
  inCurrentRoom: boolean,
  repairedStay = false,
): { joinCount?: { increment: number }; lastLeftAt?: null } {
  return {
    ...(newSessions > 0 ? { joinCount: { increment: newSessions } } : {}),
    ...(inCurrentRoom && (newSessions > 0 || repairedStay)
      ? { lastLeftAt: null }
      : {}),
  };
}

export async function handleSessionParticipantJoined(
  event: StreamSessionParticipantJoinedEvent,
): Promise<void> {
  const { call_cid, created_at, participant } = event;
  const streamCallId = toCallId(call_cid);
  const userId = participant?.user?.id;

  if (!userId) {
    streamLogger.warn("Participant joined event missing user id", {
      streamCallId,
    });
    return;
  }

  try {
    const resolved = await resolveMeeting(streamCallId);
    if (!resolved) {
      streamLogger.warn("Meeting not found for participant joined", {
        streamCallId,
        userId,
      });
      return;
    }
    const { meeting, isCurrentSegment } = resolved;
    const meetingId = meeting.id;
    const joinedAt = new Date(created_at);
    const userSessionId = presenceKey(event.session_id, participant, userId);

    // Touch rows in strict `Meeting -> MeetingPresence -> MeetingAttendance` order.
    await prisma.$transaction(async (tx) => {
      // A prior segment's join never reopens, or takes the end of, the current room.
      const room = isCurrentSegment
        ? await settleRoomForJoin(tx, meetingId, streamCallId, joinedAt)
        : PRIOR_SEGMENT;
      const effectiveEndedAt = room.endedAt;

      const { count: newSessions } = await tx.meetingPresence.createMany({
        data: [
          {
            meetingId,
            appointmentOccurrenceId: meeting.appointmentOccurrenceId,
            userId,
            userSessionId,
            streamCallId,
            joinedAt,
            ...(effectiveEndedAt
              ? { leftAt: effectiveEndedAt, closedByEnd: true }
              : {}),
          },
        ],
        skipDuplicates: true,
      });

      let repairedStay = false;
      if (newSessions === 0) {
        await tx.meetingPresence.updateMany({
          where: {
            meetingId,
            userSessionId,
            joinedAt: { gt: joinedAt },
          },
          data: { joinedAt },
        });
        // A device row closed before it joined was a wrong assumed close; a join to the live room reopens it.
        if (room.current && !effectiveEndedAt) {
          const repaired = await tx.meetingPresence.updateMany({
            where: {
              meetingId,
              userSessionId,
              leftAt: { lt: prisma.meetingPresence.fields.joinedAt },
            },
            data: { leftAt: null, closedByEnd: false },
          });
          repairedStay = repaired.count > 0;
        }
      }

      await tx.meetingAttendance.upsert({
        where: {
          meetingId_userId: { meetingId, userId },
        },
        create: {
          meetingId,
          appointmentOccurrenceId: meeting.appointmentOccurrenceId,
          userId,
          firstJoinedAt: joinedAt,
          ...(effectiveEndedAt ? { lastLeftAt: effectiveEndedAt } : {}),
        },
        update: buildAttendanceJoinUpdate(
          newSessions,
          room.current && !effectiveEndedAt,
          repairedStay,
        ),
      });

      await tx.meetingAttendance.updateMany({
        where: {
          meetingId,
          userId,
          firstJoinedAt: { gt: joinedAt },
        },
        data: { firstJoinedAt: joinedAt },
      });
    });

    streamLogger.info("Recorded participant join", {
      streamCallId,
      meetingId,
      userId,
      userSessionId: participant.user_session_id,
    });
  } catch (error) {
    streamLogger.error("Failed to handle participant joined event", error, {
      streamCallId,
      userId,
    });
    throw error;
  }
}

export async function handleSessionParticipantLeft(
  event: StreamSessionParticipantLeftEvent,
): Promise<void> {
  const { call_cid, created_at, participant } = event;
  const streamCallId = toCallId(call_cid);
  const userId = participant?.user?.id;

  if (!userId) {
    streamLogger.warn("Participant left event missing user id", {
      streamCallId,
    });
    return;
  }

  try {
    const resolved = await resolveMeeting(streamCallId);
    if (!resolved) {
      streamLogger.warn("Meeting not found for participant left", {
        streamCallId,
        userId,
      });
      return;
    }
    const { meeting, isCurrentSegment } = resolved;
    const meetingId = meeting.id;

    const leftAt = new Date(created_at);
    const joinedAt = new Date(
      leftAt.getTime() - Math.max(0, event.duration_seconds ?? 0) * 1000,
    );
    const userSessionId = presenceKey(event.session_id, participant, userId);
    const attendanceLeftAt = isCurrentSegment
      ? clampLeaveToRoomEnd(meeting, joinedAt, leftAt)
      : leftAt;

    // A leave takes no room lock: it touches `MeetingPresence` then `MeetingAttendance`, the order every writer uses.
    await prisma.$transaction(async (tx) => {
      const { count: newSessions } = await tx.meetingPresence.createMany({
        data: [
          {
            meetingId,
            appointmentOccurrenceId: meeting.appointmentOccurrenceId,
            userId,
            userSessionId,
            streamCallId,
            joinedAt,
            leftAt,
          },
        ],
        skipDuplicates: true,
      });

      // A reported leave always replaces an end-stamp close; between reported leaves the later wins.
      await tx.meetingPresence.updateMany({
        where: {
          meetingId,
          userSessionId,
          OR: [
            { leftAt: null },
            { closedByEnd: true },
            { leftAt: { lt: leftAt } },
          ],
        },
        data: { leftAt, closedByEnd: false },
      });

      if (newSessions === 0 && (event.duration_seconds ?? 0) > 0) {
        await tx.meetingPresence.updateMany({
          where: {
            meetingId,
            userSessionId,
            joinedAt: { gt: joinedAt },
          },
          data: { joinedAt },
        });
      }

      await tx.meetingAttendance.upsert({
        where: {
          meetingId_userId: { meetingId, userId },
        },
        create: {
          meetingId,
          appointmentOccurrenceId: meeting.appointmentOccurrenceId,
          userId,
          firstJoinedAt: joinedAt,
          lastLeftAt: attendanceLeftAt,
        },
        update:
          newSessions > 0 ? { joinCount: { increment: newSessions } } : {},
      });

      // A prior segment's late leave never marks a user back in the current room as left.
      if (isCurrentSegment) {
        await tx.meetingAttendance.updateMany({
          where: {
            meetingId,
            userId,
            OR: [
              { lastLeftAt: null },
              { lastLeftAt: { lt: attendanceLeftAt } },
            ],
          },
          data: { lastLeftAt: attendanceLeftAt },
        });
      }

      if ((event.duration_seconds ?? 0) > 0) {
        await tx.meetingAttendance.updateMany({
          where: {
            meetingId,
            userId,
            firstJoinedAt: { gt: joinedAt },
          },
          data: { firstJoinedAt: joinedAt },
        });
      }
    });

    streamLogger.info("Recorded participant leave", {
      streamCallId,
      meetingId,
      userId,
      durationSeconds: event.duration_seconds,
    });
  } catch (error) {
    streamLogger.error("Failed to handle participant left event", error, {
      streamCallId,
      userId,
    });
    throw error;
  }
}
