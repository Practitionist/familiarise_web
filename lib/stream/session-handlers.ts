/**
 * Stream call lifecycle webhooks, which keep room state only: `call.session_ended`
 * and `call.ended` stamp `Meeting.endedAt` and `endedReason`, and a join to the
 * current call after a non-deliberate, rejoinable end clears them, because Stream resumed
 * the room. Attendance is never written here; the outcome sweep reads Stream's
 * settled record (`settleOccurrenceAttendance`).
 */

import prisma from "@/lib/prisma";
import {
  END_REASON_POLICY,
  MEETING_END_REASONS,
  mapStreamCallEndedReason,
  recordedEndHolds,
  type MeetingEndReason,
} from "@/lib/meetings/end-reasons";
import {
  parseSlotIdFromCallId,
  STREAM_CALL_TYPE,
  toCallId,
} from "@/lib/stream/call-cid";
import { streamLogger } from "@/lib/stream-logger";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";

export interface StreamSessionEndedEvent {
  call_cid: string;
  type: "call.session_ended";
  created_at: string;
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
  session_id?: string;
}

export interface StreamStatsReportReadyEvent {
  call_cid: string;
  type: "call.stats_report_ready" | "call.report_ready";
  created_at: string;
  session_id: string;
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

const MEETING_END_INCLUDE = { occurrence: true } as const;

export async function handleSessionEnded(
  event: StreamSessionEndedEvent,
): Promise<void> {
  const { call_cid, created_at } = event;
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
      streamLogger.info("Stale end event — a later end is already recorded", {
        sessionId: meeting.id,
        streamCallId,
        previousEndedAt: meeting.endedAt,
      });
      return;
    }

    if (await newerSessionHolds(streamCallId, endedAt)) {
      streamLogger.info("Stale timeout — a newer session holds the room", {
        sessionId: meeting.id,
        streamCallId,
      });
      return;
    }

    const slotEndsAt = meeting.occurrence.endsAt;
    const bookedTimeIsOver = !slotEndsAt || endedAt >= new Date(slotEndsAt);

    const stamped = await stampEnd(
      meeting,
      endedAt,
      "session_timeout",
      event.session_id ?? null,
    );
    if (!stamped) return;

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
      streamLogger.info("Stale end event — a later end is already recorded", {
        sessionId: meeting.id,
        streamCallId,
        previousEndedAt: meeting.endedAt,
      });
      return;
    }

    if (
      !(await stampEnd(
        meeting,
        endedAt,
        endedReason,
        event.call?.session?.id ?? null,
      ))
    )
      return;

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
    const rotate = (expected: RecordedEnd, at: Date) =>
      prisma.meeting.updateMany({
        where: {
          id: meeting.id,
          streamCallId: meeting.streamCallId,
          endedAt: expected.endedAt,
          endedReason: expected.endedReason,
        },
        data: {
          endedAt: at,
          endedReason,
          streamCallId: nextStreamCallId,
          isRecording: false,
        },
      });
    let rotated = await rotate(meeting, endedAt);
    if (rotated.count === 0) {
      // The end webhook may have stamped this call first; rotate on top of a non-deliberate end, never a deliberate one.
      const room = await prisma.meeting.findUnique({
        where: { id: meeting.id },
        select: { streamCallId: true, endedAt: true, endedReason: true },
      });
      if (!room || room.streamCallId !== meeting.streamCallId) {
        return {
          kind: "already_ended",
          streamCallId: room?.streamCallId ?? meeting.streamCallId,
        };
      }
      if (recordedEndHolds(room, endedReason)) return alreadyEnded;
      const at =
        room.endedAt && room.endedAt > endedAt ? room.endedAt : endedAt;
      rotated = await rotate(room, at);
    }
    if (rotated.count === 0) return alreadyEnded;
    return { kind: "recorded", endedReason, streamCallId: nextStreamCallId };
  }

  if (!(await stampEnd(meeting, endedAt, endedReason))) return alreadyEnded;
  return { kind: "recorded", endedReason, streamCallId: meeting.streamCallId };
}

/**
 * True when Stream is running a session on this call that began after `endedAt`,
 * so a timeout delivered late belongs to an earlier session. A failed read
 * answers false, which stamps the timeout as before.
 */
async function newerSessionHolds(
  streamCallId: string,
  endedAt: Date,
): Promise<boolean> {
  if (!isStreamConfigured()) return false;
  try {
    const { call } = await withStreamCircuitBreaker(() =>
      getStreamVideoClient().video.call(STREAM_CALL_TYPE, streamCallId).get(),
    );
    const session = call.session;
    if (!session || session.ended_at || !session.started_at) return false;
    return new Date(session.started_at).getTime() > endedAt.getTime();
  } catch {
    return false;
  }
}

type RecordedEnd = { endedAt: Date | null; endedReason: string | null };

/** Stamps the end on the room's current call, compare-and-set on the call id and the end (stamp and reason) the caller read. */
function casEnd(
  meeting: { id: string; streamCallId: string },
  expected: RecordedEnd,
  endedAt: Date,
  endedReason: MeetingEndReason,
  sessionId: string | null,
) {
  return prisma.meeting.updateMany({
    where: {
      id: meeting.id,
      streamCallId: meeting.streamCallId,
      endedAt: expected.endedAt,
      endedReason: expected.endedReason,
      // A join newer than a non-deliberate end means a newer session holds the room.
      ...(!END_REASON_POLICY[endedReason].deliberate && {
        OR: [{ lastJoinedAt: null }, { lastJoinedAt: { lte: endedAt } }],
      }),
    },
    data: {
      endedAt,
      endedReason,
      isRecording: false,
      ...(sessionId ? { lastStreamSessionId: sessionId } : {}),
    },
  });
}

async function stampEnd(
  meeting: { id: string; streamCallId: string } & RecordedEnd,
  endedAt: Date,
  endedReason: MeetingEndReason,
  sessionId: string | null = null,
): Promise<boolean> {
  let { count } = await casEnd(
    meeting,
    meeting,
    endedAt,
    endedReason,
    sessionId,
  );
  if (count === 0) {
    // Another end committed first: re-decide against it, on the same call only.
    const room = await prisma.meeting.findUnique({
      where: { id: meeting.id },
      select: { streamCallId: true, endedAt: true, endedReason: true },
    });
    if (
      room?.streamCallId === meeting.streamCallId &&
      endSupersedes(room, endedReason, endedAt)
    ) {
      ({ count } = await casEnd(
        meeting,
        room,
        endedAt,
        endedReason,
        sessionId,
      ));
    }
  }
  if (count === 0) {
    streamLogger.info("End not stamped — the room's end changed concurrently", {
      sessionId: meeting.id,
    });
  }
  return count > 0;
}

/** True when an incoming end replaces the recorded one: a deliberate end beats a non-deliberate one whatever their stamps; otherwise the later end wins. */
function endSupersedes(
  recorded: RecordedEnd,
  incoming: MeetingEndReason,
  incomingAt: Date,
): boolean {
  if (!recorded.endedAt) return true;
  if (recordedEndHolds(recorded, incoming)) return false;
  if (END_REASON_POLICY[incoming].deliberate) return true;
  return incomingAt.getTime() > recorded.endedAt.getTime();
}

/** The ends a later join may undo: no person closed the room and its policy lets participants rejoin it. */
const REOPENABLE_END_REASONS = MEETING_END_REASONS.filter(
  (reason) =>
    !END_REASON_POLICY[reason].deliberate &&
    END_REASON_POLICY[reason].rejoinable,
);

/**
 * A join to the current call after a non-deliberate, rejoinable end means Stream resumed
 * the room, so the end is cleared; Extend, recording and seat adds need an open room.
 */
export async function handleSessionParticipantJoined(
  event: StreamSessionParticipantJoinedEvent,
): Promise<void> {
  const streamCallId = toCallId(event.call_cid);
  const joinedAt = new Date(event.created_at);
  const newerJoin = {
    OR: [{ lastJoinedAt: null }, { lastJoinedAt: { lt: joinedAt } }],
  };
  // The session it names is recorded only when the join postdates the last join and any recorded end,
  // so an earlier session's late join never replaces a later one's identity.
  if (event.session_id) {
    await prisma.meeting.updateMany({
      where: {
        streamCallId,
        AND: [
          newerJoin,
          { OR: [{ endedAt: null }, { endedAt: { lt: joinedAt } }] },
        ],
      },
      data: { lastJoinedAt: joinedAt, lastStreamSessionId: event.session_id },
    });
  }
  // The watermark moves before the reopen, so an older non-deliberate end can no longer stamp this call.
  await prisma.meeting.updateMany({
    where: { streamCallId, ...newerJoin },
    data: { lastJoinedAt: joinedAt },
  });
  const { count } = await prisma.meeting.updateMany({
    where: {
      streamCallId,
      endedAt: { lt: joinedAt },
      endedReason: { in: [...REOPENABLE_END_REASONS] },
    },
    data: { endedAt: null, endedReason: null },
  });
  if (count > 0) {
    streamLogger.info("Room reopened by a join after its end", {
      streamCallId,
    });
  }
}

/** Records that Stream announced one session's stats report ready; attendance for it settles only after this. */
export async function handleStatsReportReady(
  event: StreamStatsReportReadyEvent,
): Promise<void> {
  const callId = toCallId(event.call_cid);
  // A rotated-away call's report belongs to the same occurrence's room.
  const occurrenceId = parseSlotIdFromCallId(callId);
  const { count } = await prisma.meeting.updateMany({
    where: {
      OR: [
        { streamCallId: callId },
        ...(occurrenceId ? [{ appointmentOccurrenceId: occurrenceId }] : []),
      ],
      NOT: { streamReportReadySessionIds: { has: event.session_id } },
    },
    data: { streamReportReadySessionIds: { push: event.session_id } },
  });
  streamLogger.info("Stream stats report ready", {
    streamCallId: callId,
    recorded: count > 0,
  });
}
