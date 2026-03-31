/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import {
  notifyRecordingAvailable,
  notifyRecordingFailed,
} from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
import { generateRecordingTitle } from "@/lib/stream/recording-utils";

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
            user: { select: { id: true } },
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
                webinar: {
                  include: {
                    webinarPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
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

    const appointment = meetingSession.slotOfAppointment.appointment;
    const title = generateRecordingTitle(appointment, startDate);

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

    // Build recipient list — for webinar/class, include all enrolled attendees
    // (the meeting session slot only has the consultant's allocation slot users)
    let userIds = meetingSession.slotOfAppointment.user?.map(
      (u: { id: string }) => u.id,
    ) ?? [];

    if (appointment?.webinar) {
      // Get users from all appointment slots for this webinar
      const slotUsers = await prisma.slotOfAppointment.findMany({
        where: { appointment: { webinarId: appointment.webinar.id } },
        select: { user: { select: { id: true } } },
      });
      // Get booked waitlist users
      const waitlistEntries = await prisma.waitlist.findMany({
        where: { webinarId: appointment.webinar.id, status: "BOOKED" },
        select: { userId: true },
      });
      const allIds = [
        ...userIds,
        ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
        ...waitlistEntries.map((w) => w.userId),
      ];
      userIds = Array.from(new Set(allIds));
    } else if (appointment?.class) {
      const slotUsers = await prisma.slotOfAppointment.findMany({
        where: { appointment: { classId: appointment.class.id } },
        select: { user: { select: { id: true } } },
      });
      const waitlistEntries = await prisma.waitlist.findMany({
        where: { classId: appointment.class.id, status: "BOOKED" },
        select: { userId: true },
      });
      const allIds = [
        ...userIds,
        ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
        ...waitlistEntries.map((w) => w.userId),
      ];
      userIds = Array.from(new Set(allIds));
    }

    if (userIds.length > 0) {
      let appointmentType = "consultation";
      let consultantName = "Unknown Consultant";

      if (appointment?.consultation) {
        appointmentType = "consultation";
        consultantName =
          appointment.consultation.consultationPlan?.consultantProfile?.user
            ?.name ?? "Unknown Consultant";
      } else if (appointment?.subscription) {
        appointmentType = "subscription";
        consultantName =
          appointment.subscription.subscriptionPlan?.consultantProfile?.user
            ?.name ?? "Unknown Consultant";
      } else if (appointment?.webinar) {
        appointmentType = "webinar";
        consultantName =
          appointment.webinar.webinarPlan?.consultantProfile?.user?.name ??
          "Unknown Consultant";
      } else if (appointment?.class) {
        appointmentType = "class";
        consultantName =
          appointment.class.classPlan?.consultantProfile?.user?.name ??
          "Unknown Consultant";
      }

      void notifyRecordingAvailable(userIds, {
        appointmentType,
        consultantName,
        recordingUrl: url,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      }).catch((err) =>
        streamLogger.error("Failed to send recording notification", err, {
          streamCallId,
        }),
      );
    }
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
            appointment: {
              include: {
                webinar: { select: { id: true } },
                class: { select: { id: true } },
              },
            },
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
        status: RecordingStatus.FAILED,
        meetingSessionId: meetingSession.id,
      },
    });

    // Build recipient list — for webinar/class, include all enrolled attendees
    const appointment = meetingSession.slotOfAppointment.appointment;
    let userIds = meetingSession.slotOfAppointment.user.map((u) => u.id);

    if (appointment?.webinar) {
      // Get users from all appointment slots for this webinar
      const slotUsers = await prisma.slotOfAppointment.findMany({
        where: { appointment: { webinarId: appointment.webinar.id } },
        select: { user: { select: { id: true } } },
      });
      // Get booked waitlist users
      const waitlistEntries = await prisma.waitlist.findMany({
        where: { webinarId: appointment.webinar.id, status: "BOOKED" },
        select: { userId: true },
      });
      const allIds = [
        ...userIds,
        ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
        ...waitlistEntries.map((w) => w.userId),
      ];
      userIds = Array.from(new Set(allIds));
    } else if (appointment?.class) {
      const slotUsers = await prisma.slotOfAppointment.findMany({
        where: { appointment: { classId: appointment.class.id } },
        select: { user: { select: { id: true } } },
      });
      const waitlistEntries = await prisma.waitlist.findMany({
        where: { classId: appointment.class.id, status: "BOOKED" },
        select: { userId: true },
      });
      const allIds = [
        ...userIds,
        ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
        ...waitlistEntries.map((w) => w.userId),
      ];
      userIds = Array.from(new Set(allIds));
    }
    const notificationResults = await Promise.allSettled(
      userIds.map((userId) =>
        notifyRecordingFailed(userId, {
          streamCallId,
          errorMessage: eventError?.message,
          dashboardUrl: `${getAppUrl()}/dashboard`,
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
