/**
 * Stream call lifecycle webhooks, which keep room state only: `call.session_ended`
 * and `call.ended` stamp `Meeting.endedAt` and `endedReason`, and a join to the
 * current call after a non-deliberate end clears them, because Stream resumed
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
import { toCallId } from "@/lib/stream/call-cid";
import { streamLogger } from "@/lib/stream-logger";

export interface StreamSessionEndedEvent {
  call_cid: string;
  type: "call.session_ended";
  created_at: string;
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

    const slotEndsAt = meeting.occurrence.endsAt;
    const bookedTimeIsOver = !slotEndsAt || endedAt >= new Date(slotEndsAt);

    const stamped = await stampEnd(meeting, endedAt, "session_timeout");
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

    if (!(await stampEnd(meeting, endedAt, endedReason))) return;

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
    const rotated = await prisma.meeting.updateMany({
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
    if (rotated.count === 0) return alreadyEnded;
    return { kind: "recorded", endedReason, streamCallId: nextStreamCallId };
  }

  if (!(await stampEnd(meeting, endedAt, endedReason))) return alreadyEnded;
  return { kind: "recorded", endedReason, streamCallId: meeting.streamCallId };
}

type RecordedEnd = { endedAt: Date | null; endedReason: string | null };

/** Stamps the end on the room's current call, compare-and-set on the call id and the end (stamp and reason) the caller read. */
function casEnd(
  meeting: { id: string; streamCallId: string },
  expected: RecordedEnd,
  endedAt: Date,
  endedReason: MeetingEndReason,
) {
  return prisma.meeting.updateMany({
    where: {
      id: meeting.id,
      streamCallId: meeting.streamCallId,
      endedAt: expected.endedAt,
      endedReason: expected.endedReason,
    },
    data: { endedAt, endedReason, isRecording: false },
  });
}

async function stampEnd(
  meeting: { id: string; streamCallId: string } & RecordedEnd,
  endedAt: Date,
  endedReason: MeetingEndReason,
): Promise<boolean> {
  let { count } = await casEnd(meeting, meeting, endedAt, endedReason);
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
      ({ count } = await casEnd(meeting, room, endedAt, endedReason));
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

/** The ends a later join may undo: Stream resumes the call after them, and no person closed it. */
const REOPENABLE_END_REASONS = MEETING_END_REASONS.filter(
  (reason) => !END_REASON_POLICY[reason].deliberate,
);

/**
 * A join to the current call after a non-deliberate end means Stream resumed
 * the room, so the end is cleared; Extend, recording and seat adds need an open room.
 */
export async function handleSessionParticipantJoined(
  event: StreamSessionParticipantJoinedEvent,
): Promise<void> {
  const streamCallId = toCallId(event.call_cid);
  const joinedAt = new Date(event.created_at);
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
