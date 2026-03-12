/**
 * Stream Session Event Handlers
 * Handles webhook events for call lifecycle (session start/end)
 *
 * Events handled:
 * - call.session_ended: When call session ends (last participant leaves + timeout)
 * - call.ended: When call is explicitly ended
 */

import prisma from "@/lib/prisma";
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

/**
 * Handle call.session_ended event
 * Triggered when the call session naturally ends (last participant leaves + inactivity timeout)
 *
 * Actions:
 * - Update MeetingSession with endedAt timestamp
 * - Set endedReason to "session_timeout"
 * - Log session duration
 */
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
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: true,
      },
    });

    if (!meetingSession) {
      streamLogger.warn("Meeting session not found for session ended event", {
        streamCallId,
      });
      return;
    }

    // Skip if already ended
    if (meetingSession.endedAt) {
      streamLogger.info("Meeting session already marked as ended", {
        sessionId: meetingSession.id,
        streamCallId,
        previousEndedAt: meetingSession.endedAt,
      });
      return;
    }

    const endedAt = new Date(created_at);

    // Update meeting session and mark slot as completed atomically
    await prisma.$transaction([
      prisma.meetingSession.update({
        where: { id: meetingSession.id },
        data: {
          endedAt,
          endedReason: "session_timeout",
          isRecording: false,
        },
      }),
      prisma.slotOfAppointment.update({
        where: { id: meetingSession.slotOfAppointmentId },
        data: {
          completionStatus: "COMPLETED",
          completedAt: endedAt,
        },
      }),
    ]);

    // Calculate session duration if we have a start reference
    const slotStartTime = meetingSession.slotOfAppointment.startsAt;
    if (slotStartTime) {
      const durationMinutes = Math.round(
        (endedAt.getTime() - new Date(slotStartTime).getTime()) / (1000 * 60),
      );
      streamLogger.info("Session duration calculated", {
        sessionId: meetingSession.id,
        durationMinutes,
      });
    }

    streamLogger.info("Meeting session updated - session ended", {
      sessionId: meetingSession.id,
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
 * - Update MeetingSession with endedAt timestamp
 * - Set endedReason to "call_ended"
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
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: true,
      },
    });

    if (!meetingSession) {
      streamLogger.warn("Meeting session not found for call ended event", {
        streamCallId,
      });
      return;
    }

    // Skip if already ended
    if (meetingSession.endedAt) {
      streamLogger.info("Meeting session already marked as ended", {
        sessionId: meetingSession.id,
        streamCallId,
        previousEndedAt: meetingSession.endedAt,
      });
      return;
    }

    const endedAt = new Date(created_at);

    // Update meeting session and mark slot as completed atomically
    await prisma.$transaction([
      prisma.meetingSession.update({
        where: { id: meetingSession.id },
        data: {
          endedAt,
          endedReason: "call_ended",
          isRecording: false,
        },
      }),
      prisma.slotOfAppointment.update({
        where: { id: meetingSession.slotOfAppointmentId },
        data: {
          completionStatus: "COMPLETED",
          completedAt: endedAt,
        },
      }),
    ]);

    // Calculate session duration if we have a start reference
    const slotStartTime = meetingSession.slotOfAppointment.startsAt;
    if (slotStartTime) {
      const durationMinutes = Math.round(
        (endedAt.getTime() - new Date(slotStartTime).getTime()) / (1000 * 60),
      );
      streamLogger.info("Session duration calculated", {
        sessionId: meetingSession.id,
        durationMinutes,
        endedByUserId: ended_by_user_id,
      });
    }

    streamLogger.info("Meeting session updated - call ended", {
      sessionId: meetingSession.id,
      streamCallId,
      endedAt: created_at,
      endedReason: "call_ended",
      endedByUserId: ended_by_user_id,
    });
  } catch (error) {
    streamLogger.error("Failed to handle call ended event", error, {
      streamCallId,
    });
    throw error;
  }
}
