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
import { streamLogger } from "@/lib/stream-logger";
import { captureThrottled } from "@/lib/observability/throttled-capture";

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
// `participant.user.id`. `user_session_id` is the per-tab/device session: it keys
// the #1569 MeetingPresence interval, while attendance stays per app user.
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
export async function handleSessionEnded(
  event: StreamSessionEndedEvent,
): Promise<void> {
  const { call_cid, created_at } = event;

  // #C10 — the one cid → id split, lib/stream/call-cid.ts. This file held four
  // hand-rolled copies, one per event.
  const streamCallId = toCallId(call_cid);

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
      reportOrphanedStreamEvent(streamCallId, "call.session_ended");
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
    // participant leaves, so an empty room is not a finished session; the
    // `endedReason` distinguishes it from a host closing the room, and
    // `isDeliberateEnd` is what the join gates read.
    const slotEndsAt = meeting.occurrence.endsAt;
    const bookedTimeIsOver = !slotEndsAt || endedAt >= new Date(slotEndsAt);

    // CAS on the end we read: a concurrent call.ended must not be overwritten.
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

  // #C10 — the one cid → id split, lib/stream/call-cid.ts.
  const streamCallId = toCallId(call_cid);

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
      reportOrphanedStreamEvent(streamCallId, "call.ended");
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

    if (!(await stampEnd(meeting, endedAt, endedReason))) return;

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

/** #1569 — one device's stay; Stream always sends user_session_id, the fallback is per call session. */
function presenceKey(
  sessionId: string,
  participant: { user_session_id?: string },
  userId: string,
): string {
  return participant.user_session_id || `${sessionId}:${userId}`;
}

/**
 * Stamp the room's end, compare-and-set on the end this event read, so two end
 * webhooks racing each other cannot overwrite a deliberate end. False when lost.
 */
async function stampEnd(
  meeting: { id: string; endedAt: Date | null },
  endedAt: Date,
  endedReason: string,
): Promise<boolean> {
  const { count } = await prisma.meeting.updateMany({
    where: { id: meeting.id, endedAt: meeting.endedAt },
    data: { endedAt, endedReason, isRecording: false },
  });
  if (count === 0) {
    streamLogger.info("End not stamped — the room's end changed concurrently", {
      sessionId: meeting.id,
    });
  }
  return count > 0;
}

/** #1607 — the last end wins; a replayed or older event never moves endedAt backwards. */
function supersedesRecordedEnd(recorded: Date | null, incoming: Date): boolean {
  return !recorded || incoming.getTime() > recorded.getTime();
}

/**
 * #1829 — an event for a call we have no `Meeting` row for.
 *
 * This was a bare `streamLogger.warn`, and `streamLogger.warn` is
 * `console.warn` — which `lib/health/probe.ts` documents is STRIPPED from the
 * function log. So the single most diagnostic Stream event in the system was
 * invisible in production, and the only evidence it ever fired was the absence of
 * the thing it was reporting.
 *
 * That absence is the 2026-08-12 outage, exactly: 0 rows in `WebhookEvent` for
 * provider 'stream', 0 in `MeetingAttendance`, and 1,663 meetings that never
 * ended. A mis-set webhook secret, a `streamCallId` derivation that does not
 * match, or a rebuild that orphaned a room all land here, and all three read as
 * a healthy run.
 *
 * Throttled, because a mis-keyed call is not one event — it is every
 * `session_participant_joined` and `_left` for that call, on a live session,
 * which is the shape that empties a 5,000-error quota. Keyed by call so two
 * different broken rooms are two different issues rather than one that
 * suppresses the other.
 */
function reportOrphanedStreamEvent(
  streamCallId: string,
  eventType: string,
): void {
  captureThrottled(
    `stream:no-meeting-row:${streamCallId}`,
    `Stream event for a call with no Meeting row — attendance is not being recorded (${eventType})`,
    {
      subsystem: "stream",
      level: "error",
      op: "webhook.no-meeting-row",
      extra: { streamCallId, eventType },
    },
  );
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
      reportOrphanedStreamEvent(
        streamCallId,
        "call.session_participant_joined",
      );
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

    const userSessionId = presenceKey(event.session_id, participant, userId);
    // #1569 — the (meetingId, userSessionId) unique makes a replay a no-op, and
    // joinCount counts distinct device sessions, not deliveries (#1746).
    await prisma.$transaction(async (tx) => {
      const { count: newSessions } = await tx.meetingPresence.createMany({
        data: [
          {
            meetingId,
            appointmentOccurrenceId: meeting.appointmentOccurrenceId,
            userId,
            userSessionId,
            joinedAt,
          },
        ],
        skipDuplicates: true,
      });
      // firstJoinedAt is immutable so #471 reads the genuine first arrival.
      await tx.meetingAttendance.upsert({
        where: {
          meetingId_userId: { meetingId, userId },
        },
        create: {
          meetingId,
          appointmentOccurrenceId: meeting.appointmentOccurrenceId,
          userId,
          firstJoinedAt: joinedAt,
        },
        update:
          newSessions > 0 ? { joinCount: { increment: newSessions } } : {},
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

/**
 * STR-4 — Handle call.session_participant_left.
 * Stamps lastLeftAt on the participant's attendance row. If the join was never
 * recorded (missed/duplicate webhook ordering), create the row so the leave is
 * not lost — firstJoinedAt falls back to the leave time.
 *
 * The stamp is MONOTONIC (C3), on both the per-device presence row and the
 * per-user attendance summary: only a leave later than the one recorded is
 * applied. Webhook delivery is not ordered and is retried for 168 h, so "the
 * last write wins" is the wrong rule for a value that answers "is this person
 * still in the room?".
 */
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
      reportOrphanedStreamEvent(streamCallId, "call.session_participant_left");
      streamLogger.warn("Meeting not found for participant left", {
        streamCallId,
        userId,
      });
      return;
    }
    const meetingId = meeting.id;

    const leftAt = new Date(created_at);
    // #1569 — the leave carries its own duration, so a lost join is rebuilt from it.
    const joinedAt = new Date(
      leftAt.getTime() - Math.max(0, event.duration_seconds ?? 0) * 1000,
    );
    const userSessionId = presenceKey(event.session_id, participant, userId);

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
      // A replayed or older leave never moves leftAt backwards.
      await tx.meetingPresence.updateMany({
        where: {
          meetingId,
          userSessionId,
          OR: [{ leftAt: null }, { leftAt: { lt: leftAt } }],
        },
        data: { leftAt },
      });
      // upsert (not update) — a leave arriving without a recorded join still
      // creates the row, with firstJoinedAt rebuilt from the leave's duration.
      // `lastLeftAt` is NOT in the update branch, and that omission is the fix
      // (C3): Prisma has no conditional form for an upsert's update, and a bare
      // `lastLeftAt: leftAt` there let a LATE delivery move the value
      // backwards. The monotonic write is the updateMany immediately below.
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
        update: {
          ...(newSessions > 0 && { joinCount: { increment: newSessions } }),
        },
      });
      // #C3 — `lastLeftAt` is the SUMMARY of a per-user session and #472
      // (overrun) derives "still in the room" from it: a user is present while
      // `lastLeftAt` is null or older than the slot end. So a value that moves
      // BACKWARDS does not lose a millisecond, it invents an absence: a
      // participant who rejoined at 11:04 and was still on the call at 11:40
      // reads as having left at 10:58 the moment a stale `participant_left`
      // landed, and the overrun detector is downstream of that number. The
      // presence row above already carried this guard; the per-user summary did
      // not, and the summary is the one #472 reads.
      //
      // Ordered AFTER the upsert on purpose: when the upsert took its create
      // branch it has already written this exact timestamp, so this matches
      // nothing and is a no-op — which is the desired outcome anyway, not a race
      // to lose.
      await tx.meetingAttendance.updateMany({
        where: {
          meetingId,
          userId,
          OR: [{ lastLeftAt: null }, { lastLeftAt: { lt: leftAt } }],
        },
        data: { lastLeftAt: leftAt },
      });
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
