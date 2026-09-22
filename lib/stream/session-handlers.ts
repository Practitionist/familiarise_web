/**
 * Stream Session Event Handlers
 * Handles webhook events for call lifecycle (session start/end)
 *
 * Events handled:
 * - call.session_ended: When call session ends (last participant leaves + timeout)
 * - call.ended: When call is explicitly ended
 */

import prisma from "@/lib/prisma";
import { isDeliberateEnd } from "@/lib/appointments/occurrences";
import { settleSubscriptionCycle } from "@/lib/booking/subscription-cycle";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
import { streamLogger } from "@/lib/stream-logger";

// Types for Stream webhook payloads
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
  };
  ended_by_user_id?: string;
}

// STR-4 — per-participant join/leave. Stream's CallParticipantResponse nests
// the Stream user id (== our app userId, see upsertUserToStream) under
// `participant.user.id`. `user_session_id` is the per-tab/device session, used
// only for logging — attendance is keyed on the app user, not the device.
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

/**
 * Handle call.session_ended event
 * Triggered when the call session naturally ends (last participant leaves + inactivity timeout)
 *
 * Actions:
 * - Update Meeting with endedAt timestamp
 * - Set endedReason to "session_timeout"
 * - Log session duration
 */
/** #1766 — post-commit, best-effort: the relay delivers what this misses. */
async function attemptStaged(rows: StagedTrigger[]): Promise<void> {
  for (const row of rows) {
    try {
      await attemptTrigger(row);
    } catch (error) {
      streamLogger.warn("Cycle bell attempt failed; relay will retry", {
        outboxId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function handleSessionEnded(
  event: StreamSessionEndedEvent,
): Promise<void> {
  const { call_cid, created_at } = event;

  // Extract call ID from call_cid (format: "default:callId")
  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.info("Session ended", {
    streamCallId,
    endedAt: created_at,
  });

  try {
    // Find meeting session by streamCallId
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

    // A deliberate end is final: the session_ended Stream fires right after a
    // host's call.ended must not downgrade `call_ended` to a timeout that a
    // later join could clear.
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

    // #1270 — Stream fires this `inactivity_timeout_seconds` after the LAST
    // participant leaves, which on the live call type is 900 seconds. An empty
    // room is not a finished session: one party stepping out for coffee at
    // 09:56 of a 10:00-11:00 booking produced this event, and marking the slot
    // COMPLETED then made it review-eligible and handed it to
    // auto-complete-appointments — for a session that had not started.
    //
    // The session row still records that Stream's session ended, because it
    // did; `endedReason` distinguishes it from a host closing the room, and
    // `isDeliberateEnd` is what the join gates read. The SLOT only completes
    // once its booked time is actually over.
    const slotEndsAt = meeting.occurrence.endsAt;
    const bookedTimeIsOver = !slotEndsAt || endedAt >= new Date(slotEndsAt);

    const staged = await prisma.$transaction(async (tx) => {
      await tx.meeting.update({
        where: { id: meeting.id },
        data: {
          endedAt,
          endedReason: "session_timeout",
          isRecording: false,
        },
      });
      if (!bookedTimeIsOver) return [];
      // CAS (#1319): a late webhook must not resurrect a CANCELLED slot as
      // COMPLETED. Zero rows is expected here, so log rather than throw; the
      // session row above still records the truth about the call.
      const moved = await transitionOccurrenceCompletion(tx, {
        where: { id: meeting.appointmentOccurrenceId },
        to: "COMPLETED",
        // Never lift UNVERIFIED: the maintenance drain parked it for a human.
        fromIn: ["SCHEDULED"],
        data: { completedAt: endedAt },
        allowZero: true,
      });
      if (moved === 0) {
        streamLogger.info(
          "Slot not completable — already cancelled or completed",
          {
            sessionId: meeting.id,
            streamCallId,
          },
        );
        return [];
      }
      // #1766 — staged in the same tx; attempted after commit below.
      return settleSubscriptionCycle(tx, {
        appointmentId: meeting.occurrence.appointmentId,
        now: endedAt,
      });
    });
    await attemptStaged(staged);

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

    // Calculate session duration if we have a start reference
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

/**
 * Handle call.ended event
 * Triggered when a call is explicitly ended (not just session timeout)
 *
 * Actions:
 * - Update Meeting with endedAt timestamp
 * - Set endedReason to "call_ended", or "ended_early" before the booked start
 * - Log who ended the call if available
 */
export async function handleCallEnded(
  event: StreamCallEndedEvent,
): Promise<void> {
  const { call_cid, created_at, ended_by_user_id } = event;

  // Extract call ID from call_cid (format: "default:callId")
  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.info("Call ended", {
    streamCallId,
    endedAt: created_at,
    endedByUserId: ended_by_user_id,
  });

  try {
    // Find meeting session by streamCallId
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

    // #1607 — "End for everyone" during the pre-start device check is not the
    // session ending. `ended_early` is not a deliberate end, so every join gate
    // re-lights and the slot stays SCHEDULED for the real call.
    const slotStartsAt = meeting.occurrence.startsAt;
    const endedBeforeStart = !!slotStartsAt && endedAt < new Date(slotStartsAt);
    const endedReason = endedBeforeStart ? "ended_early" : "call_ended";

    // Update meeting session and mark slot as completed atomically
    const staged = await prisma.$transaction(async (tx) => {
      await tx.meeting.update({
        where: { id: meeting.id },
        data: {
          endedAt,
          endedReason,
          isRecording: false,
        },
      });
      if (endedBeforeStart) return [];
      // CAS (#1319) — see the session_timeout arm above.
      const moved = await transitionOccurrenceCompletion(tx, {
        where: { id: meeting.appointmentOccurrenceId },
        to: "COMPLETED",
        // Never lift UNVERIFIED: the maintenance drain parked it for a human.
        fromIn: ["SCHEDULED"],
        data: { completedAt: endedAt },
        allowZero: true,
      });
      if (moved === 0) {
        streamLogger.info(
          "Slot not completable — already cancelled or completed",
          {
            sessionId: meeting.id,
            streamCallId,
          },
        );
        return [];
      }
      // #1766 — see the session_timeout arm above.
      return settleSubscriptionCycle(tx, {
        appointmentId: meeting.occurrence.appointmentId,
        now: endedAt,
      });
    });
    await attemptStaged(staged);

    // Calculate session duration if we have a start reference
    const slotStartTime = meeting.occurrence.startsAt;
    if (slotStartTime) {
      const durationMinutes = Math.round(
        (endedAt.getTime() - new Date(slotStartTime).getTime()) / (1000 * 60),
      );
      streamLogger.info("Session duration calculated", {
        sessionId: meeting.id,
        durationMinutes,
        endedByUserId: ended_by_user_id,
      });
    }

    streamLogger.info("Meeting session updated - call ended", {
      sessionId: meeting.id,
      streamCallId,
      endedAt: created_at,
      endedReason,
      endedByUserId: ended_by_user_id,
    });
  } catch (error) {
    streamLogger.error("Failed to handle call ended event", error, {
      streamCallId,
    });
    throw error;
  }
}

/**
 * Resolve the Meeting for a Stream call_cid (format "type:callId").
 * Returns null (not throw) when no session matches — Stream emits participant
 * events for ad-hoc calls that may never have been persisted; those are skipped.
 */
async function resolveMeeting(streamCallId: string) {
  return prisma.meeting.findUnique({
    where: { streamCallId },
    // #1554 — attendance rows carry the call they belong to.
    select: {
      id: true,
      endedAt: true,
      endedReason: true,
      appointmentOccurrenceId: true,
    },
  });
}

/** #1607 — the last end wins; a replayed or older event never moves endedAt backwards. */
function supersedesRecordedEnd(recorded: Date | null, incoming: Date): boolean {
  return !recorded || incoming.getTime() > recorded.getTime();
}

/**
 * STR-4 — Handle call.session_participant_joined.
 * Upserts a MeetingAttendance row per (session, app user). First join stamps
 * firstJoinedAt; a rejoin increments joinCount. Unblocks #471 (no-show) and
 * #472 (overrun), which read first-join / last-leave to derive presence.
 */
export async function handleSessionParticipantJoined(
  event: StreamSessionParticipantJoinedEvent,
): Promise<void> {
  const { call_cid, created_at, participant } = event;
  const streamCallId = call_cid.split(":")[1] || call_cid;
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

    // #1607 — Stream reuses the call id across sessions, so a join after a
    // timeout or a pre-start end means the room is live again: clear the
    // non-deliberate end so heldOccurrence and the maintenance drain see it open.
    // Only a join AFTER that end counts (a late-delivered older join must not
    // reopen it); CAS on the end we read, so a concurrent real end is never
    // clobbered.
    if (
      meeting.endedAt &&
      joinedAt > meeting.endedAt &&
      !isDeliberateEnd(meeting)
    ) {
      await prisma.meeting.updateMany({
        where: { id: meetingId, endedAt: meeting.endedAt },
        data: { endedAt: null, endedReason: null },
      });
    }

    // Idempotent: a duplicate webhook for the same join must not inflate the
    // count, so the unique [meetingId, userId] row is the dedup key.
    // First join → create with firstJoinedAt; rejoin → bump joinCount only
    // (firstJoinedAt is immutable so #471 reads the genuine first arrival).
    await prisma.meetingAttendance.upsert({
      where: {
        meetingId_userId: { meetingId, userId },
      },
      create: {
        meetingId,
        appointmentOccurrenceId: meeting.appointmentOccurrenceId,
        userId,
        firstJoinedAt: joinedAt,
      },
      update: {
        joinCount: { increment: 1 },
      },
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

/**
 * STR-4 — Handle call.session_participant_left.
 * Stamps lastLeftAt on the participant's attendance row. If the join was never
 * recorded (missed/duplicate webhook ordering), create the row so the leave is
 * not lost — firstJoinedAt falls back to the leave time.
 */
export async function handleSessionParticipantLeft(
  event: StreamSessionParticipantLeftEvent,
): Promise<void> {
  const { call_cid, created_at, participant } = event;
  const streamCallId = call_cid.split(":")[1] || call_cid;
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

    // upsert (not update) — a left arriving before/without a recorded join still
    // creates the row, with firstJoinedAt defensively set to the leave time.
    await prisma.meetingAttendance.upsert({
      where: {
        meetingId_userId: { meetingId, userId },
      },
      create: {
        meetingId,
        appointmentOccurrenceId: meeting.appointmentOccurrenceId,
        userId,
        firstJoinedAt: leftAt,
        lastLeftAt: leftAt,
      },
      update: {
        lastLeftAt: leftAt,
      },
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
