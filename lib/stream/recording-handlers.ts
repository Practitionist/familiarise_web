/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import type { z } from "zod";
import { runAfterOrInline } from "@/lib/stream/run-after-or-inline";
import prisma from "@/lib/prisma";
import { RecordingStatus, RecordingStorageType } from "@prisma/client";
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
  streamCopyExpiresAt,
} from "@/lib/stream/recording-utils";
import { parseSlotIdFromCallId, toCallId } from "@/lib/stream/call-cid";
import {
  discardDeclinedRecording,
  wasDeclinedDuringRecording,
} from "@/lib/stream/recording-decline";
import type {
  streamRecordingFailedSchema,
  streamRecordingReadySchema,
} from "@/lib/stream/webhook-dispatch";

export { parseSlotIdFromCallId };

const RECORDING_READY_INCLUDE = {
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
} as const;

const RECORDING_FAILED_INCLUDE = {
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
} as const;

async function findMeetingForRecordingReady(streamCallId: string) {
  const direct = await prisma.meeting.findUnique({
    where: { streamCallId },
    include: RECORDING_READY_INCLUDE,
  });
  if (direct) return direct;
  const slotId = parseSlotIdFromCallId(streamCallId);
  if (!slotId) return null;
  return prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: slotId },
    include: RECORDING_READY_INCLUDE,
  });
}

async function findMeetingForRecordingFailed(streamCallId: string) {
  const direct = await prisma.meeting.findUnique({
    where: { streamCallId },
    include: RECORDING_FAILED_INCLUDE,
  });
  if (direct) return direct;
  const slotId = parseSlotIdFromCallId(streamCallId);
  if (!slotId) return null;
  return prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: slotId },
    include: RECORDING_FAILED_INCLUDE,
  });
}

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

type StreamRecordingReadyEvent = z.infer<typeof streamRecordingReadySchema>;

type StreamRecordingFailedEvent = z.infer<typeof streamRecordingFailedSchema>;

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

    const startedAt = new Date(created_at);
    const shouldAdvanceStartedAt =
      !meeting.recordingStartedAt || startedAt > meeting.recordingStartedAt;
    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        isRecording: true,
        ...(shouldAdvanceStartedAt ? { recordingStartedAt: startedAt } : {}),
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

    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        isRecording: false,
      },
    });

    await prisma.recording.updateMany({
      where: {
        meetingId: meeting.id,
        status: RecordingStatus.RECORDING,
      },
      data: {
        status: RecordingStatus.PROCESSING,
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

/** Statuses a recording_ready may promote to READY. */
const PRE_READY_STATUSES: RecordingStatus[] = [
  RecordingStatus.RECORDING,
  RecordingStatus.PROCESSING,
  RecordingStatus.FAILED,
];

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
        dashboardUrl: notificationHref(
          appointment?.organizationId,
          "recordings",
        ),
      },
      `recording.ready:${recordingId}`,
      { deferAttempt: true, entityRef: `recording:${recordingId}` },
    )) ?? [];

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

type ReadyRecordingParams = {
  meetingId: string;
  streamCallId: string;
  filename: string;
  title: string;
  url: string;
  durationInMinutes: number;
  startDate: Date;
  streamUrlExpiresAt: Date;
  organizationId: string | null;
};

async function createReadyRecordingOrAdoptRace(
  params: ReadyRecordingParams,
): Promise<{ id: string }> {
  try {
    return await prisma.recording.create({
      data: {
        title: params.title,
        recordingUrl: params.url,
        durationInMinutes: params.durationInMinutes,
        recordedAt: params.startDate,
        streamRecordingId: params.filename,
        streamCallId: params.streamCallId,
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt: params.streamUrlExpiresAt,
        meetingId: params.meetingId,
        organizationId: params.organizationId,
      },
    });
  } catch (createError) {
    const isUniqueConflict =
      typeof createError === "object" &&
      createError !== null &&
      "code" in createError &&
      createError.code === "P2002";
    if (!isUniqueConflict) throw createError;

    const racedRecording = await prisma.recording.findFirst({
      where: {
        meetingId: params.meetingId,
        streamRecordingId: params.filename,
      },
    });
    if (!racedRecording) throw createError;

    streamLogger.info(
      "Concurrent recording create detected, adopting existing row",
      {
        recordingId: racedRecording.id,
        streamRecordingId: params.filename,
      },
    );
    return racedRecording;
  }
}

async function resolveReadyRecordingRecord(
  params: ReadyRecordingParams,
): Promise<{ id: string }> {
  const existingRecording =
    (await prisma.recording.findFirst({
      where: {
        meetingId: params.meetingId,
        streamRecordingId: params.filename,
      },
    })) ??
    (await prisma.recording.findFirst({
      where: {
        meetingId: params.meetingId,
        status: {
          in: PRE_READY_STATUSES,
        },
      },
      orderBy: { createdAt: "desc" },
    }));

  if (!existingRecording) {
    return createReadyRecordingOrAdoptRace(params);
  }

  const canPromote =
    existingRecording.storageType !== "PLATFORM" &&
    existingRecording.status !== "AVAILABLE" &&
    existingRecording.status !== "TRANSFERRING" &&
    PRE_READY_STATUSES.includes(existingRecording.status);

  if (!canPromote) {
    streamLogger.info("Recording already exists, adopting existing row", {
      recordingId: existingRecording.id,
      streamRecordingId: params.filename,
    });
    return existingRecording;
  }

  const [adopted] = await prisma.recording.updateManyAndReturn({
    where: {
      id: existingRecording.id,
      status: { in: PRE_READY_STATUSES },
    },
    data: {
      title: params.title,
      recordingUrl: params.url,
      durationInMinutes: params.durationInMinutes,
      recordedAt: params.startDate,
      streamRecordingId: params.filename,
      streamCallId: params.streamCallId,
      storageType: RecordingStorageType.STREAM_S3,
      status: RecordingStatus.READY,
      streamUrlExpiresAt: params.streamUrlExpiresAt,
      organizationId: params.organizationId,
    },
  });
  if (!adopted) {
    throw new Error(
      `Recording ${existingRecording.id} changed while marking it ready`,
    );
  }
  return adopted;
}

export async function handleRecordingReady(
  event: StreamRecordingReadyEvent,
): Promise<void> {
  const { call_cid, call_recording } = event;

  const streamCallId = toCallId(call_cid);
  const { filename, url, start_time, end_time, session_id } = call_recording;

  streamLogger.info("Recording ready", {
    streamCallId,
    filename,
    url: url.substring(0, 50) + "...",
  });

  try {
    const meeting = await findMeetingForRecordingReady(streamCallId);

    if (!meeting) {
      streamLogger.warn("Meeting session not found for recording ready event", {
        streamCallId,
      });
      return;
    }

    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    const rawDurationMs = endDate.getTime() - startDate.getTime();
    const durationInMinutes = Number.isFinite(rawDurationMs)
      ? Math.max(0, Math.round(rawDurationMs / (1000 * 60)))
      : 0;

    const appointment = meeting.occurrence.appointment;

    if (await wasDeclinedDuringRecording(meeting.id, appointment, endDate)) {
      await discardDeclinedRecording({
        meetingId: meeting.id,
        streamCallId,
        sessionId: session_id,
        filename,
      });
      if (meeting.isRecording) {
        await prisma.meeting.update({
          where: { id: meeting.id },
          data: { isRecording: false },
        });
      }
      return;
    }

    const title = generateRecordingTitle(appointment, startDate);
    const recording = await resolveReadyRecordingRecord({
      meetingId: meeting.id,
      streamCallId,
      filename,
      title,
      url,
      durationInMinutes,
      startDate,
      streamUrlExpiresAt: streamCopyExpiresAt(endDate),
      organizationId: appointment?.organizationId ?? null,
    });

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

    await stageAndSendRecordingReadyNotifications(
      appointment,
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

const RECORDING_FAILED_NOTIFY_CONCURRENCY = 5;

async function notifyRecordingFailedChunked(
  userIds: string[],
  streamCallId: string,
  organizationId: string | null | undefined,
): Promise<void> {
  const dashboardUrl = notificationHref(organizationId, "recordings");
  const results: PromiseSettledResult<unknown>[] = [];

  for (
    let i = 0;
    i < userIds.length;
    i += RECORDING_FAILED_NOTIFY_CONCURRENCY
  ) {
    const batch = userIds.slice(i, i + RECORDING_FAILED_NOTIFY_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((userId) =>
        notifyRecordingFailed(userId, {
          streamCallId,
          dashboardUrl,
        }),
      ),
    );
    results.push(...settled);
  }

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    streamLogger.warn(
      `${failures.length}/${userIds.length} recording-failed notifications failed`,
      { streamCallId },
    );
  }
}

/**
 * Handle call.recording_failed event
 * Logs the error and optionally notifies the consultant
 */
export async function handleRecordingFailed(
  event: StreamRecordingFailedEvent,
): Promise<void> {
  const { call_cid, egress_id, recording_type } = event;

  const streamCallId = toCallId(call_cid);

  streamLogger.error(
    "Recording failed",
    new Error(
      `Stream ${recording_type} recording failed (egress ${egress_id})`,
    ),
    { streamCallId, egressId: egress_id, recordingType: recording_type },
  );

  try {
    const meeting = await findMeetingForRecordingFailed(streamCallId);

    if (!meeting) {
      streamLogger.warn(
        "Meeting session not found for recording failed event",
        {
          streamCallId,
        },
      );
      return;
    }

    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        isRecording: false,
      },
    });

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

    const appointment = meeting.occurrence.appointment;
    const userIds = await getEventAttendeeIds(appointment);

    await notifyRecordingFailedChunked(
      userIds,
      streamCallId,
      appointment?.organizationId,
    );

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
