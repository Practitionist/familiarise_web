/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import { runAfterOrInline } from "@/lib/stream/run-after-or-inline";
import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import {
  notifyRecordingAvailable,
  notifyRecordingFailed,
} from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import {
  generateRecordingTitle,
  getEventAttendeeIds,
} from "@/lib/stream/recording-utils";
import { toCallId } from "@/lib/stream/call-cid";
import {
  RecordingTransferService,
  resolveAppointmentStoragePolicy,
} from "@/lib/stream/recording-transfer-service";

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
 * Updates Meeting to mark recording as active
 */
export async function handleRecordingStarted(
  event: StreamRecordingStartedEvent,
): Promise<void> {
  const { call_cid, user, created_at } = event;

  const streamCallId = toCallId(call_cid);

  streamLogger.info("Recording started", {
    streamCallId,
    userId: user?.id,
    startedAt: created_at,
  });

  try {
    // Find meeting session by streamCallId
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
    });

    if (!meeting) {
      streamLogger.warn(
        "Meeting session not found for recording started event",
        {
          streamCallId,
        },
      );
      return;
    }

    // #1615 — the route's claim is the source of truth for the actor and the
    // claim time; the webhook only confirms, so both fields are first-write-wins.
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        isRecording: true,
        ...(meeting.recordingStartedAt
          ? {}
          : { recordingStartedAt: new Date(created_at) }),
        ...(!meeting.recordingStartedBy && user?.id
          ? { recordingStartedBy: user.id }
          : {}),
      },
    });

    streamLogger.info("Meeting session updated - recording started", {
      sessionId: meeting.id,
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
 * Updates Meeting to mark recording as stopped
 */
export async function handleRecordingStopped(
  event: StreamRecordingStoppedEvent,
): Promise<void> {
  const { call_cid } = event;

  const streamCallId = toCallId(call_cid);

  streamLogger.info("Recording stopped", { streamCallId });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
    });

    if (!meeting) {
      streamLogger.warn(
        "Meeting session not found for recording stopped event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to mark recording as stopped
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        isRecording: false,
      },
    });

    streamLogger.info("Meeting session updated - recording stopped", {
      sessionId: meeting.id,
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
type RecordingNotificationAppointment = Parameters<
  typeof getEventAttendeeIds
>[0] & {
  organizationId?: string | null;
  consultation?: {
    consultationPlan?: {
      consultantProfile?: { user?: { name?: string | null } | null } | null;
    } | null;
  } | null;
  subscription?: {
    subscriptionPlan?: {
      consultantProfile?: { user?: { name?: string | null } | null } | null;
    } | null;
  } | null;
  trial?: {
    subscriptionPlan?: {
      consultantProfile?: { user?: { name?: string | null } | null } | null;
    } | null;
  } | null;
  webinar?: {
    webinarPlan?: {
      consultantProfile?: { user?: { name?: string | null } | null } | null;
    } | null;
  } | null;
  class?: {
    classPlan?: {
      consultantProfile?: { user?: { name?: string | null } | null } | null;
    } | null;
  } | null;
};

function resolveRecordingNotificationMeta(
  appointment: RecordingNotificationAppointment | null | undefined,
): { appointmentType: string; consultantName: string } {
  if (appointment?.consultation) {
    return {
      appointmentType: "consultation",
      consultantName:
        appointment.consultation.consultationPlan?.consultantProfile?.user
          ?.name ?? "Unknown Consultant",
    };
  }
  if (appointment?.subscription) {
    return {
      appointmentType: "subscription",
      consultantName:
        appointment.subscription.subscriptionPlan?.consultantProfile?.user
          ?.name ?? "Unknown Consultant",
    };
  }
  if (appointment?.trial) {
    return {
      appointmentType: "trial",
      consultantName:
        appointment.trial.subscriptionPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant",
    };
  }
  if (appointment?.webinar) {
    return {
      appointmentType: "webinar",
      consultantName:
        appointment.webinar.webinarPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant",
    };
  }
  if (appointment?.class) {
    return {
      appointmentType: "class",
      consultantName:
        appointment.class.classPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant",
    };
  }
  return {
    appointmentType: "consultation",
    consultantName: "Unknown Consultant",
  };
}

async function stageAndSendRecordingReadyNotifications(
  appointment: RecordingNotificationAppointment | null | undefined,
  url: string,
  recordingId: string,
  streamCallId: string,
): Promise<void> {
  const userIds = await getEventAttendeeIds(appointment);
  if (userIds.length === 0) return;

  const { appointmentType, consultantName } =
    resolveRecordingNotificationMeta(appointment);

  const staged =
    (await notifyRecordingAvailable(
      userIds,
      {
        ...notificationScope(appointment?.organizationId),
        appointmentType,
        consultantName,
        recordingUrl: url,
        dashboardUrl: notificationHref(
          appointment?.organizationId,
          "recordings",
        ),
      },
      { deferAttempt: true },
    ).catch((err) => {
      streamLogger.warn("Failed to stage recording notifications", {
        recordingId,
        streamCallId,
        error: err,
      });
      return [];
    })) ?? [];

  const stagedRows = staged
    .map((r) => r.staged)
    .filter((row): row is StagedTrigger => Boolean(row));

  if (stagedRows.length > 0) {
    await runAfterOrInline(() =>
      Promise.all(
        stagedRows.map((row) =>
          attemptTrigger(row).catch((err) =>
            streamLogger.error("Failed to send recording notification", err, {
              streamCallId,
            }),
          ),
        ),
      ),
    );
  }
}

export async function handleRecordingReady(
  event: StreamRecordingReadyEvent,
): Promise<void> {
  const { call_cid, call_recording, created_at: _created_at } = event;

  const streamCallId = toCallId(call_cid);
  const { filename, url, start_time, end_time } = call_recording;

  streamLogger.info("Recording ready", {
    streamCallId,
    filename,
    url: url.substring(0, 50) + "...",
  });

  try {
    // Find meeting session by streamCallId
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
      include: {
        occurrence: {
          include: {
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
                trial: {
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

    if (!meeting) {
      streamLogger.warn("Meeting session not found for recording ready event", {
        streamCallId,
      });
      return;
    }

    // Calculate duration in minutes (clamped to >= 0)
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    const rawDurationMs = endDate.getTime() - startDate.getTime();
    const durationInMinutes = Number.isFinite(rawDurationMs)
      ? Math.max(0, Math.round(rawDurationMs / (1000 * 60)))
      : 0;

    const appointment = meeting.occurrence.appointment;
    const title = generateRecordingTitle(appointment, startDate);

    // Calculate Stream URL expiration (2 weeks from now)
    const streamUrlExpiresAt = new Date();
    streamUrlExpiresAt.setDate(streamUrlExpiresAt.getDate() + 14);

    // Check if recording already exists by streamRecordingId or active placeholder
    const existingRecording =
      (await prisma.recording.findFirst({
        where: {
          meetingId: meeting.id,
          streamRecordingId: filename,
        },
      })) ??
      (await prisma.recording.findFirst({
        where: {
          meetingId: meeting.id,
          status: {
            in: [RecordingStatus.PROCESSING, RecordingStatus.RECORDING],
          },
        },
        orderBy: { createdAt: "desc" },
      }));

    const alreadyTransferred =
      existingRecording?.storageType === "PLATFORM" ||
      existingRecording?.status === "AVAILABLE";

    let recording: NonNullable<typeof existingRecording>;
    if (existingRecording) {
      if (
        !alreadyTransferred &&
        existingRecording.status !== "TRANSFERRING" &&
        (existingRecording.status === "PROCESSING" ||
          existingRecording.status === "RECORDING" ||
          existingRecording.status === "EXPIRED" ||
          existingRecording.status === "FAILED")
      ) {
        recording = await prisma.recording.update({
          where: { id: existingRecording.id },
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
            organizationId: appointment?.organizationId ?? null,
          },
        });
      } else {
        streamLogger.info("Recording already exists, adopting existing row", {
          recordingId: existingRecording.id,
          streamRecordingId: filename,
        });
        if (meeting.isRecording) {
          await prisma.meeting.update({
            where: { id: meeting.id },
            data: { isRecording: false },
          });
        }
        return;
      }
    } else {
      recording = await prisma.recording.create({
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
          meetingId: meeting.id,
          organizationId: appointment?.organizationId ?? null,
        },
      });
    }

    // Also update the meeting session to stop recording state if still active
    if (meeting.isRecording) {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: { isRecording: false },
      });
    }

    const recordingId = recording.id;
    streamLogger.info("Recording ready processed", {
      recordingId,
      sessionId: meeting.id,
      title,
      durationInMinutes,
    });

    const storagePolicy = resolveAppointmentStoragePolicy(appointment);
    if (
      !alreadyTransferred &&
      recording.status !== "TRANSFERRING" &&
      (storagePolicy === "PERMANENT" || storagePolicy === "SUPABASE_PERMANENT")
    ) {
      await runAfterOrInline(() =>
        RecordingTransferService.queueRecordingTransfer(recordingId).catch(
          (err) =>
            streamLogger.error("Ready-time transfer kick threw", err, {
              recordingId,
            }),
        ),
      );
    }

    await stageAndSendRecordingReadyNotifications(
      appointment,
      url,
      recordingId,
      streamCallId,
    );
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

  const streamCallId = toCallId(call_cid);

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
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
      include: {
        occurrence: {
          include: {
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

    if (!meeting) {
      streamLogger.warn(
        "Meeting session not found for recording failed event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to stop recording state
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        isRecording: false,
      },
    });

    // Create a failed recording record for tracking. Stamp the parent
    // appointment's `organizationId` so the failure shows up under the
    // host org's dashboard rather than orphaning under "personal".
    // #1589 M-P1-06 — one FAILED row per call: a sweeper re-drive of the
    // same event used to mint another (a failed event carries no recording id).
    const alreadyRecorded = await prisma.recording.findFirst({
      where: {
        meetingId: meeting.id,
        streamCallId,
        status: RecordingStatus.FAILED,
      },
      select: { id: true },
    });
    if (!alreadyRecorded) {
      await prisma.recording.create({
        data: {
          title: "Recording Failed",
          recordingUrl: "",
          durationInMinutes: 0,
          recordedAt: new Date(),
          streamCallId,
          status: RecordingStatus.FAILED,
          meetingId: meeting.id,
          organizationId:
            meeting.occurrence.appointment?.organizationId ?? null,
        },
      });
    }

    // Build recipient list — every live seat holder of the booking (#1554)
    const appointment = meeting.occurrence.appointment;
    const userIds = await getEventAttendeeIds(appointment);

    const notificationResults = await Promise.allSettled(
      userIds.map((userId) =>
        notifyRecordingFailed(userId, {
          streamCallId,
          errorMessage: eventError?.message,
          // #1527 — every live seat holder (consultant or consultee) is a
          // recipient here, same as the recording-ready bell above.
          dashboardUrl: notificationHref(
            appointment?.organizationId,
            "recordings",
          ),
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
      sessionId: meeting.id,
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
