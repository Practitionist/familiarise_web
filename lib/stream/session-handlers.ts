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
import { parseSlotIdFromCallId, toCallId } from "@/lib/stream/call-cid";
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
 * Backfills webinar/class participant presence and attendance rows missed during end-of-call bursts,
 * preserving `Meeting -> MeetingPresence -> MeetingAttendance` lock ordering.
 */
export async function reconcileWebinarAttendance(
  meeting: {
    id: string;
    streamCallId: string;
    appointmentOccurrenceId: string;
  } & GroupSessionCandidate,
  endedAt: Date,
): Promise<void> {
  const slotOfAppointment = meeting.occurrence?.appointment;
  if (!slotOfAppointment?.webinar && !slotOfAppointment?.class) {
    return;
  }

  const intervals = await getCallParticipantSessionsFromStream(
    meeting.streamCallId,
  );
  if (intervals.length === 0) return;

  const summaryByUser = summarizeParticipantIntervals(intervals, endedAt);

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

async function runBestEffortGroupReconciliation(
  meeting: {
    id: string;
    streamCallId: string;
    appointmentOccurrenceId: string;
  } & GroupSessionCandidate,
  endedAt: Date,
): Promise<void> {
  try {
    await reconcileWebinarAttendance(meeting, endedAt);
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

    if (
      isDeliberateEnd(meeting) ||
      !supersedesRecordedEnd(meeting.endedAt, endedAt)
    ) {
      await runBestEffortGroupReconciliation(
        meeting,
        meeting.endedAt ?? endedAt,
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

    await runBestEffortGroupReconciliation(meeting, endedAt);

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

    if (!supersedesRecordedEnd(meeting.endedAt, endedAt)) {
      await runBestEffortGroupReconciliation(
        meeting,
        meeting.endedAt ?? endedAt,
      );
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

    await runBestEffortGroupReconciliation(meeting, endedAt);

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
      hasEndedByUser,
    });
  } catch (error) {
    streamLogger.error("Failed to handle call ended event", error, {
      streamCallId,
    });
    throw error;
  }
}

/**
 * Synchronously stamps `Meeting.endedAt` and `endedReason` on host-initiated
 * termination before navigating back to the dashboard, eliminating webhook lag.
 */
export async function recordMeetingEndedSynchronously(
  streamCallId: string,
  endedAt: Date = new Date(),
): Promise<{
  endedReason: "ended_early" | "call_ended";
  nextStreamCallId: string;
} | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { streamCallId },
    include: { occurrence: true },
  });
  if (!meeting) return null;

  if (!supersedesRecordedEnd(meeting.endedAt, endedAt)) {
    return null;
  }

  const slotStartsAt = meeting.occurrence.startsAt;
  const endedBeforeStart = !!slotStartsAt && endedAt < new Date(slotStartsAt);
  const endedReason = endedBeforeStart ? "ended_early" : "call_ended";

  if (endedBeforeStart) {
    const nextStreamCallId = `occurrence-${meeting.occurrence.id}-r${endedAt.getTime().toString(36)}`;
    const updated = await prisma.meeting.updateMany({
      where: { id: meeting.id, endedAt: meeting.endedAt },
      data: {
        endedAt,
        endedReason,
        streamCallId: nextStreamCallId,
        isRecording: false,
      },
    });
    if (updated.count === 0) return null;
    return { endedReason, nextStreamCallId };
  }

  if (!(await stampEnd(meeting, endedAt, endedReason))) return null;
  return { endedReason, nextStreamCallId: meeting.streamCallId };
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
  if (direct) return direct;

  const occurrenceId = parseSlotIdFromCallId(streamCallId);
  if (!occurrenceId) return null;

  return prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: occurrenceId },
    select,
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

function buildAttendanceJoinUpdate(
  newSessions: number,
  effectiveEndedAt: Date | null,
): { joinCount?: { increment: number }; lastLeftAt?: null } {
  if (newSessions <= 0) return {};
  if (effectiveEndedAt) {
    return { joinCount: { increment: newSessions } };
  }
  return { joinCount: { increment: newSessions }, lastLeftAt: null };
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
    const userSessionId = presenceKey(event.session_id, participant, userId);

    // Touch rows in strict `Meeting -> MeetingPresence -> MeetingAttendance` order.
    await prisma.$transaction(async (tx) => {
      let effectiveEndedAt = meeting.endedAt ?? null;
      if (reopensSession) {
        const reopened = await tx.meeting?.updateMany?.({
          where: { id: meetingId, endedAt: meeting.endedAt },
          data: { endedAt: null, endedReason: null },
        });
        if (reopened && reopened.count > 0) {
          effectiveEndedAt = null;
        } else {
          const latest = await tx.meeting.findUnique({
            where: { id: meeting.id },
            select: { endedAt: true },
          });
          effectiveEndedAt = latest?.endedAt ?? meeting.endedAt ?? null;
        }
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
        update: buildAttendanceJoinUpdate(newSessions, effectiveEndedAt),
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
