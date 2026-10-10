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

import prisma from "@/lib/prisma";
import { isDeliberateEnd } from "@/lib/appointments/occurrences";
import { toCallId } from "@/lib/stream/call-cid";
import { getCallParticipantSessionsFromStream } from "@/lib/stream/call-presence";
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
    created_by_user_id?: string;
    ended_by_user_id?: string;
  };
  user?: {
    id: string;
    [key: string]: unknown;
  };
  reason?: string;
  ended_by_user_id?: string;
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

function resolveCallEndedReason(
  endedBeforeStart: boolean,
  endedByUserId: string | null,
  reason?: string,
): string {
  if (endedBeforeStart) return "ended_early";
  if (
    reason &&
    reason !== "call_ended" &&
    reason !== "end_call" &&
    !endedByUserId
  ) {
    return reason;
  }
  return "call_ended";
}

/**
 * Backfills participant presence and attendance rows missed during end-of-call webhook bursts,
 * preserving strict `Meeting -> MeetingPresence -> MeetingAttendance` lock ordering.
 */
export async function reconcileWebinarAttendance(
  meeting: {
    id: string;
    streamCallId: string;
    appointmentOccurrenceId: string;
  },
  endedAt: Date,
): Promise<void> {
  const intervals = await getCallParticipantSessionsFromStream(
    meeting.streamCallId,
  );
  if (intervals.length === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.meetingPresence.createMany({
      data: intervals.map((interval) => ({
        meetingId: meeting.id,
        appointmentOccurrenceId: meeting.appointmentOccurrenceId,
        userId: interval.userId,
        userSessionId: interval.userSessionId,
        joinedAt: interval.joinedAt,
        leftAt: interval.leftAt ?? endedAt,
      })),
      skipDuplicates: true,
    });

    await tx.meetingPresence.updateMany?.({
      where: { meetingId: meeting.id, leftAt: null },
      data: { leftAt: endedAt },
    });

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
      } else {
        if (interval.joinedAt < existing.firstJoinedAt) {
          existing.firstJoinedAt = interval.joinedAt;
        }
        if (effectiveLeft > existing.lastLeftAt) {
          existing.lastLeftAt = effectiveLeft;
        }
        existing.count += 1;
      }
    }

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
      await tx.meetingAttendance.updateMany?.({
        where: {
          meetingId: meeting.id,
          userId,
          firstJoinedAt: { gt: summary.firstJoinedAt },
        },
        data: { firstJoinedAt: summary.firstJoinedAt },
      });
      await tx.meetingAttendance.updateMany?.({
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
      include: {
        occurrence: true,
      },
    });

    if (!meeting) {
      streamLogger.warn("Meeting session not found for session ended event", {
        streamCallId,
      });
      return;
    }

    const endedAt = new Date(created_at);

    if (
      isDeliberateEnd(meeting) ||
      !supersedesRecordedEnd(meeting.endedAt, endedAt)
    ) {
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

    await reconcileWebinarAttendance(meeting, endedAt);

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

  const streamCallId = toCallId(call_cid);

  streamLogger.info("Call ended", {
    streamCallId,
    endedAt: created_at,
    endedByUserId,
  });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
      include: {
        occurrence: true,
      },
    });

    if (!meeting) {
      streamLogger.warn("Meeting session not found for call ended event", {
        streamCallId,
      });
      return;
    }

    const endedAt = new Date(created_at);

    if (!supersedesRecordedEnd(meeting.endedAt, endedAt)) {
      streamLogger.info("Stale end event — a later end is already recorded", {
        sessionId: meeting.id,
        streamCallId,
        previousEndedAt: meeting.endedAt,
      });
      return;
    }

    const slotStartsAt = meeting.occurrence.startsAt;
    const endedBeforeStart = !!slotStartsAt && endedAt < new Date(slotStartsAt);
    const endedReason = resolveCallEndedReason(
      endedBeforeStart,
      endedByUserId,
      event.reason,
    );

    if (!(await stampEnd(meeting, endedAt, endedReason))) return;

    await reconcileWebinarAttendance(meeting, endedAt);

    const slotStartTime = meeting.occurrence.startsAt;
    if (slotStartTime) {
      const durationMinutes = Math.round(
        (endedAt.getTime() - new Date(slotStartTime).getTime()) / (1000 * 60),
      );
      streamLogger.info("Session duration calculated", {
        sessionId: meeting.id,
        durationMinutes,
        endedByUserId,
      });
    }

    streamLogger.info("Meeting session updated - call ended", {
      sessionId: meeting.id,
      streamCallId,
      endedAt: created_at,
      endedReason,
      endedByUserId,
    });
  } catch (error) {
    streamLogger.error("Failed to handle call ended event", error, {
      streamCallId,
    });
    throw error;
  }
}

async function resolveMeeting(streamCallId: string) {
  return prisma.meeting.findUnique({
    where: { streamCallId },
    select: {
      id: true,
      endedAt: true,
      endedReason: true,
      appointmentOccurrenceId: true,
    },
  });
}

function presenceKey(
  sessionId: string,
  participant: { user_session_id?: string },
  userId: string,
): string {
  return participant.user_session_id || `${sessionId}:${userId}`;
}

function stampEnd(
  meeting: { id: string; endedAt: Date | null },
  endedAt: Date,
  endedReason: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.meeting.updateMany({
      where: { id: meeting.id, endedAt: meeting.endedAt },
      data: { endedAt, endedReason, isRecording: false },
    });
    if (count === 0) {
      streamLogger.info(
        "End not stamped — the room's end changed concurrently",
        {
          sessionId: meeting.id,
        },
      );
      return false;
    }
    await tx.meetingPresence?.updateMany?.({
      where: { meetingId: meeting.id, leftAt: null },
      data: { leftAt: endedAt },
    });
    await tx.meetingAttendance?.updateMany?.({
      where: { meetingId: meeting.id, lastLeftAt: null },
      data: { lastLeftAt: endedAt },
    });
    return true;
  });
}

function supersedesRecordedEnd(recorded: Date | null, incoming: Date): boolean {
  return !recorded || incoming.getTime() > recorded.getTime();
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
    const meeting = await resolveMeeting(streamCallId);
    if (!meeting) {
      streamLogger.warn("Meeting not found for participant joined", {
        streamCallId,
        userId,
      });
      return;
    }
    const meetingId = meeting.id;
    const joinedAt = new Date(created_at);

    const reopensSession = Boolean(
      meeting.endedAt &&
      joinedAt > meeting.endedAt &&
      !isDeliberateEnd(meeting),
    );
    const effectiveEndedAt = reopensSession ? null : (meeting.endedAt ?? null);
    const userSessionId = presenceKey(event.session_id, participant, userId);

    // Acquire row locks in strict `Meeting -> MeetingPresence -> MeetingAttendance` order.
    await prisma.$transaction(async (tx) => {
      if (reopensSession) {
        await tx.meeting?.updateMany?.({
          where: { id: meetingId, endedAt: meeting.endedAt },
          data: { endedAt: null, endedReason: null },
        });
      }

      const { count: newSessions } = await tx.meetingPresence.createMany({
        data: [
          {
            meetingId,
            appointmentOccurrenceId: meeting.appointmentOccurrenceId,
            userId,
            userSessionId,
            joinedAt,
            ...(effectiveEndedAt ? { leftAt: effectiveEndedAt } : {}),
          },
        ],
        skipDuplicates: true,
      });

      if (newSessions === 0) {
        await tx.meetingPresence.updateMany?.({
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
          ...(effectiveEndedAt ? { lastLeftAt: effectiveEndedAt } : {}),
        },
        update:
          newSessions > 0
            ? effectiveEndedAt
              ? { joinCount: { increment: newSessions } }
              : { joinCount: { increment: newSessions }, lastLeftAt: null }
            : {},
      });

      await tx.meetingAttendance.updateMany?.({
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
    const meeting = await resolveMeeting(streamCallId);
    if (!meeting) {
      streamLogger.warn("Meeting not found for participant left", {
        streamCallId,
        userId,
      });
      return;
    }
    const meetingId = meeting.id;

    const leftAt = new Date(created_at);
    const joinedAt = new Date(
      leftAt.getTime() - Math.max(0, event.duration_seconds ?? 0) * 1000,
    );
    const userSessionId = presenceKey(event.session_id, participant, userId);

    // Acquire row locks in strict `Meeting -> MeetingPresence -> MeetingAttendance` order.
    await prisma.$transaction(async (tx) => {
      const { count: newSessions } = await tx.meetingPresence.createMany({
        data: [
          {
            meetingId,
            appointmentOccurrenceId: meeting.appointmentOccurrenceId,
            userId,
            userSessionId,
            joinedAt,
            leftAt,
          },
        ],
        skipDuplicates: true,
      });

      await tx.meetingPresence.updateMany({
        where: {
          meetingId,
          userSessionId,
          OR: [{ leftAt: null }, { leftAt: { lt: leftAt } }],
        },
        data: { leftAt },
      });

      if (newSessions === 0 && (event.duration_seconds ?? 0) > 0) {
        await tx.meetingPresence.updateMany?.({
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
          lastLeftAt: leftAt,
        },
        update:
          newSessions > 0 ? { joinCount: { increment: newSessions } } : {},
      });

      await tx.meetingAttendance.updateMany?.({
        where: {
          meetingId,
          userId,
          OR: [{ lastLeftAt: null }, { lastLeftAt: { lt: leftAt } }],
        },
        data: { lastLeftAt: leftAt },
      });

      if ((event.duration_seconds ?? 0) > 0) {
        await tx.meetingAttendance.updateMany?.({
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
