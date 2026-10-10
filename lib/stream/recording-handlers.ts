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
import { parseOccurrenceIdFromCallId, toCallId } from "@/lib/stream/call-cid";
import {
  discardDeclinedRecording,
  wasDeclinedDuringRecording,
} from "@/lib/stream/recording-decline";
import type {
  streamRecordingFailedSchema,
  streamRecordingReadySchema,
} from "@/lib/stream/webhook-dispatch";

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

/** Statuses a recording_ready may promote to READY. */
const PRE_READY_STATUSES: RecordingStatus[] = [
  RecordingStatus.RECORDING,
  RecordingStatus.PROCESSING,
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
    const readyInclude = {
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

    const occurrenceId = parseOccurrenceIdFromCallId(streamCallId);
    const meeting =
      (await prisma.meeting.findUnique({
        where: { streamCallId },
        include: readyInclude,
      })) ??
      (occurrenceId
        ? await prisma.meeting.findUnique({
            where: { appointmentOccurrenceId: occurrenceId },
            include: readyInclude,
          })
        : null);

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
    const streamUrlExpiresAt = streamCopyExpiresAt(endDate);

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

    let recording: NonNullable<typeof existingRecording>;
    if (existingRecording) {
      const existingAlreadyTransferred =
        existingRecording.storageType === "PLATFORM" ||
        existingRecording.status === "AVAILABLE";
      if (
        !existingAlreadyTransferred &&
        existingRecording.status !== "TRANSFERRING" &&
        (existingRecording.status === "PROCESSING" ||
          existingRecording.status === "RECORDING" ||
          existingRecording.status === "EXPIRED" ||
          existingRecording.status === "FAILED")
      ) {
        // recording_stopped may move RECORDING to PROCESSING mid-flight; both precede READY.
        const fromStatuses: RecordingStatus[] = PRE_READY_STATUSES.includes(
          existingRecording.status,
        )
          ? PRE_READY_STATUSES
          : [existingRecording.status];
        const [adopted] = await prisma.recording.updateManyAndReturn({
          where: { id: existingRecording.id, status: { in: fromStatuses } },
          data: {
            title,
            recordingUrl: url,
            durationInMinutes,
            recordedAt: startDate,
            streamRecordingId: filename,
            streamCallId,
            storageType: RecordingStorageType.STREAM_S3,
            status: RecordingStatus.READY,
            streamUrlExpiresAt,
            organizationId: appointment?.organizationId ?? null,
          },
        });
        // The row moved past READY's prerequisites; throw so the redelivery re-reads it.
        if (!adopted) {
          throw new Error(
            `Recording ${existingRecording.id} changed while marking it ready`,
          );
        }
        recording = adopted;
      } else {
        streamLogger.info("Recording already exists, adopting existing row", {
          recordingId: existingRecording.id,
          streamRecordingId: filename,
        });
        recording = existingRecording;
      }
    } else {
      try {
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
      } catch (createError) {
        if ((createError as { code?: string })?.code === "P2002") {
          const racedRecording = await prisma.recording.findFirst({
            where: {
              meetingId: meeting.id,
              streamRecordingId: filename,
            },
          });
          if (racedRecording) {
            streamLogger.info(
              "Concurrent recording create detected, adopting existing row",
              {
                recordingId: racedRecording.id,
                streamRecordingId: filename,
              },
            );
            recording = racedRecording;
          } else {
            throw createError;
          }
        } else {
          throw createError;
        }
      }
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
    const failedInclude = {
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
    const occurrenceId = parseOccurrenceIdFromCallId(streamCallId);
    const meeting =
      (await prisma.meeting.findUnique({
        where: { streamCallId },
        include: failedInclude,
      })) ??
      (occurrenceId
        ? await prisma.meeting.findUnique({
            where: { appointmentOccurrenceId: occurrenceId },
            include: failedInclude,
          })
        : null);

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
          // Every live seat holder is a recipient, same as the recording-ready bell.
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
