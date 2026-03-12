/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { notifyRecordingFailed } from "@/lib/novu/service";

// Types for Stream webhook payloads
export interface StreamRecordingStartedEvent {
  call_cid: string;
  type: "call.recording_started";
  user?: {
    id: string;
    name?: string;
  };
  created_at: string;
}

export interface StreamRecordingStoppedEvent {
  call_cid: string;
  type: "call.recording_stopped";
  created_at: string;
}

export interface StreamRecordingReadyEvent {
  call_cid: string;
  type: "call.recording_ready";
  call_recording: {
    filename: string;
    url: string;
    start_time: string;
    end_time: string;
  };
  created_at: string;
}

export interface StreamRecordingFailedEvent {
  call_cid: string;
  type: "call.recording_failed";
  error?: {
    message?: string;
    code?: string;
  };
  created_at: string;
}

/**
 * Handle call.recording_started event
 * Updates MeetingSession to mark recording as active
 */
export async function handleRecordingStarted(
  event: StreamRecordingStartedEvent,
): Promise<void> {
  const { call_cid, user, created_at } = event;

  // Extract call ID from call_cid (format: "default:callId")
  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.info("Recording started", {
    streamCallId,
    userId: user?.id,
    startedAt: created_at,
  });

  try {
    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
    });

    if (!meetingSession) {
      streamLogger.warn(
        "Meeting session not found for recording started event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to mark recording as active
    await prisma.meetingSession.update({
      where: { id: meetingSession.id },
      data: {
        isRecording: true,
        recordingStartedAt: new Date(created_at),
        recordingStartedBy: user?.id || null,
      },
    });

    streamLogger.info("Meeting session updated - recording started", {
      sessionId: meetingSession.id,
      streamCallId,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording started event", error, {
      streamCallId,
    });
    throw error;
  }
}

/**
 * Handle call.recording_stopped event
 * Updates MeetingSession to mark recording as stopped
 */
export async function handleRecordingStopped(
  event: StreamRecordingStoppedEvent,
): Promise<void> {
  const { call_cid } = event;

  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.info("Recording stopped", { streamCallId });

  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
    });

    if (!meetingSession) {
      streamLogger.warn(
        "Meeting session not found for recording stopped event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to mark recording as stopped
    await prisma.meetingSession.update({
      where: { id: meetingSession.id },
      data: {
        isRecording: false,
      },
    });

    streamLogger.info("Meeting session updated - recording stopped", {
      sessionId: meetingSession.id,
      streamCallId,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording stopped event", error, {
      streamCallId,
    });
    throw error;
  }
}

/**
 * Handle call.recording_ready event
 * Creates a Recording record in the database
 */
export async function handleRecordingReady(
  event: StreamRecordingReadyEvent,
): Promise<void> {
  const { call_cid, call_recording, created_at: _created_at } = event;

  const streamCallId = call_cid.split(":")[1] || call_cid;
  const { filename, url, start_time, end_time } = call_recording;

  streamLogger.info("Recording ready", {
    streamCallId,
    filename,
    url: url.substring(0, 50) + "...",
  });

  try {
    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: true,
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: true,
                  },
                },
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!meetingSession) {
      streamLogger.warn("Meeting session not found for recording ready event", {
        streamCallId,
      });
      return;
    }

    // Calculate duration in minutes
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    const durationInMinutes = Math.round(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60),
    );

    // Generate title from appointment info
    const appointment = meetingSession.slotOfAppointment.appointment;
    let title = "Recording";

    if (appointment?.webinar?.webinarPlan?.title) {
      title = `Webinar: ${appointment.webinar.webinarPlan.title}`;
    } else if (appointment?.class?.classPlan?.title) {
      title = `Class: ${appointment.class.classPlan.title}`;
    } else if (appointment?.consultation?.consultationPlan?.title) {
      title = `Consultation: ${appointment.consultation.consultationPlan.title}`;
    } else if (appointment?.subscription?.subscriptionPlan?.title) {
      title = `Subscription: ${appointment.subscription.subscriptionPlan.title}`;
    }

    // Add date to title
    const dateStr = startDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    title = `${title} - ${dateStr}`;

    // Calculate Stream URL expiration (2 weeks from now)
    const streamUrlExpiresAt = new Date();
    streamUrlExpiresAt.setDate(streamUrlExpiresAt.getDate() + 14);

    // Check if recording already exists (idempotency)
    const existingRecording = await prisma.recording.findFirst({
      where: {
        meetingSessionId: meetingSession.id,
        streamRecordingId: filename,
      },
    });

    if (existingRecording) {
      streamLogger.info("Recording already exists, skipping creation", {
        recordingId: existingRecording.id,
        streamRecordingId: filename,
      });
      return;
    }

    // Create recording record
    const recording = await prisma.recording.create({
      data: {
        title,
        recordingUrl: url,
        durationInMinutes,
        recordedAt: startDate,
        streamRecordingId: filename,
        streamCallId,
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt,
        meetingSessionId: meetingSession.id,
      },
    });

    // Also update the meeting session to stop recording state if still active
    if (meetingSession.isRecording) {
      await prisma.meetingSession.update({
        where: { id: meetingSession.id },
        data: { isRecording: false },
      });
    }

    streamLogger.info("Recording created successfully", {
      recordingId: recording.id,
      sessionId: meetingSession.id,
      title,
      durationInMinutes,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording ready event", error, {
      streamCallId,
      filename,
    });
    throw error;
  }
}

/**
 * Handle call.recording_failed event
 * Logs the error and optionally notifies the consultant
 */
export async function handleRecordingFailed(
  event: StreamRecordingFailedEvent,
): Promise<void> {
  const { call_cid, error: eventError } = event;

  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.error(
    "Recording failed",
    new Error(eventError?.message || "Unknown error"),
    {
      streamCallId,
      errorCode: eventError?.code,
      errorMessage: eventError?.message,
    },
  );

  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            user: { select: { id: true } },
          },
        },
      },
    });

    if (!meetingSession) {
      streamLogger.warn(
        "Meeting session not found for recording failed event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to stop recording state
    await prisma.meetingSession.update({
      where: { id: meetingSession.id },
      data: {
        isRecording: false,
      },
    });

    // Create a failed recording record for tracking
    await prisma.recording.create({
      data: {
        title: "Recording Failed",
        recordingUrl: "",
        durationInMinutes: 0,
        recordedAt: new Date(),
        streamCallId,
        status: "FAILED" as RecordingStatus,
        meetingSessionId: meetingSession.id,
      },
    });

    // Notify all users linked to the slot (consultant + consultee)
    const userIds = meetingSession.slotOfAppointment.user.map((u) => u.id);
    const notificationResults = await Promise.allSettled(
      userIds.map((userId) =>
        notifyRecordingFailed(userId, {
          streamCallId,
          errorMessage: eventError?.message,
          dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard`,
        }),
      ),
    );

    const failures = notificationResults.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      streamLogger.warn(
        `${failures.length}/${userIds.length} recording-failed notifications failed`,
        { streamCallId },
      );
    }

    streamLogger.info("Meeting session updated - recording failed", {
      sessionId: meetingSession.id,
      streamCallId,
      notifiedUsers: userIds.length,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording failed event", error, {
      streamCallId,
    });
    throw error;
  }
}
