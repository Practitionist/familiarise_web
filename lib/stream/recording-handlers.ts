/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import type { z } from "zod";
import prisma from "@/lib/prisma";
import {
  type Prisma,
  RecordingStatus,
  RecordingStorageType,
} from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { errorMessageOf } from "@/lib/observability/report";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { stageDocumentAndRecordingEmailOnce } from "@/lib/email/senders/booking";
import { permanentFailure } from "@/lib/webhooks/event-log";
import { type StagedTrigger } from "@/lib/novu";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  notifyRecordingAvailable,
  notifyRecordingFailed,
} from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { appointmentRecordingsHref } from "@/lib/novu/resolve-href";
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
import { purgeExpiredRecordingAssets } from "@/lib/stream/recording-retention";
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

async function findMeetingForRecordingStarted(streamCallId: string) {
  const direct = await prisma.meeting.findUnique({ where: { streamCallId } });
  if (direct) return direct;
  const slotId = parseSlotIdFromCallId(streamCallId);
  if (!slotId) return null;
  return prisma.meeting.findUnique({
    where: { appointmentOccurrenceId: slotId },
  });
}

/** A Stream timestamp, or now when it does not parse. */
function eventTime(value: string): Date {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

/**
 * Clear the REC flag only for the meeting's current call and a segment that
 * began no later than `at`, so a late event for an earlier segment or a
 * rotated call never clears a live one.
 */
function clearRecordingFlag(
  meetingId: string,
  streamCallId: string,
  at: Date,
): Promise<{ count: number }> {
  return prisma.meeting.updateMany({
    where: {
      id: meetingId,
      streamCallId,
      OR: [{ recordingStartedAt: null }, { recordingStartedAt: { lte: at } }],
    },
    data: { isRecording: false },
  });
}

/** Statuses a ready notice may describe; a removed or expired row is never announced. */
const NOTIFIABLE_STATUSES: RecordingStatus[] = [
  RecordingStatus.READY,
  RecordingStatus.TRANSFERRING,
  RecordingStatus.AVAILABLE,
];

/** Claims outlive the webhook sweeper's 168-hour retry horizon. */
const NOTICE_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    const meeting = await findMeetingForRecordingStarted(streamCallId);

    if (!meeting) {
      streamLogger.warn(
        "Meeting session not found for recording started event",
        {
          streamCallId,
        },
      );
      return;
    }

    if (meeting.streamCallId !== streamCallId) {
      streamLogger.info("Recording started on a superseded call; flag kept", {
        sessionId: meeting.id,
        streamCallId,
        currentStreamCallId: meeting.streamCallId,
      });
      return;
    }

    const startedAt = eventTime(created_at);
    const shouldAdvanceStartedAt =
      !meeting.recordingStartedAt || startedAt > meeting.recordingStartedAt;
    const metadataUpdate = {
      ...(shouldAdvanceStartedAt ? { recordingStartedAt: startedAt } : {}),
      ...(!meeting.recordingStartedBy && user?.id
        ? { recordingStartedBy: user.id }
        : {}),
    };

    // Guard isRecording=true via CAS on endedAt=null so out-of-order starts never re-arm ended meetings.
    const activated = await prisma.meeting.updateMany({
      where: { id: meeting.id, streamCallId, endedAt: null },
      data: {
        isRecording: true,
        ...metadataUpdate,
      },
    });

    if (activated.count === 0 && Object.keys(metadataUpdate).length > 0) {
      await prisma.meeting.updateMany({
        where: { id: meeting.id },
        data: metadataUpdate,
      });
    }

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

    const cleared = await clearRecordingFlag(
      meeting.id,
      streamCallId,
      eventTime(event.created_at),
    );
    if (cleared.count === 0) {
      streamLogger.info(
        "Stale recording stop ignored; a later segment is live",
        {
          sessionId: meeting.id,
          streamCallId,
        },
      );
      return;
    }

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

/**
 * Announce a live recording. A removed or expired row is never announced, and
 * the bell (`transactionId`) and email (per-recipient claim) are each
 * at-most-once, so a repeated ready event or a reconciler pass stays silent.
 */
export async function stageAndSendRecordingReadyNotifications(
  appointment: RecordingNotificationAppointment | null | undefined,
  recordingId: string,
): Promise<void> {
  const row = await prisma.recording.findUnique({
    where: { id: recordingId },
    select: { status: true, removedAt: true },
  });
  if (!row || row.removedAt || !NOTIFIABLE_STATUSES.includes(row.status)) {
    return;
  }
  if (!appointment) return;
  const userIds = await getEventAttendeeIds(appointment);
  if (userIds.length === 0) return;

  const { appointmentType, consultantName } =
    resolveRecordingNotificationMeta(appointment);
  const dashboardUrl = appointmentRecordingsHref(
    appointment.organizationId,
    appointment.id,
  );

  // Sequential: the email claim runs in a transaction, which holds the only
  // pooled connection under PG_POOL_MAX=1.
  const [bellOutcome] = await Promise.allSettled([
    notifyRecordingAvailable(
      userIds,
      {
        ...notificationScope(appointment.organizationId),
        appointmentType,
        consultantName,
        dashboardUrl,
      },
      `recording.ready:${recordingId}`,
      { deferAttempt: true, entityRef: `recording:${recordingId}` },
    ),
  ]);
  const [emailOutcome] = await Promise.allSettled([
    stageDocumentAndRecordingEmailOnce(
      {
        entityId: recordingId,
        userIds,
        kind: "RECORDING_READY",
        appointmentType,
        dashboardUrl,
      },
      {
        scope: "stream.recording-ready",
        key: (userId) => `recording-ready:${recordingId}:${userId}`,
        ttlMs: NOTICE_CLAIM_TTL_MS,
      },
    ),
  ]);

  const staged = bellOutcome.status === "fulfilled" ? bellOutcome.value : [];
  if (emailOutcome.status === "rejected") {
    streamLogger.warn("Recording-ready emails not staged", {
      recordingId,
      error: errorMessageOf(emailOutcome.reason),
    });
  }
  const readyEmails =
    emailOutcome.status === "fulfilled" ? emailOutcome.value : [];

  await flushNotificationsAfter(
    {
      bells: (staged ?? []).map((r) => r?.staged),
      emails: [
        {
          list: readyEmails,
          emailType: "RECORDING_READY",
          budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
        },
      ],
    },
    "recording.ready",
  );

  // A rejection leaves no claim behind, so the retried event stages it again.
  if (bellOutcome.status === "rejected") throw bellOutcome.reason;
  if (emailOutcome.status === "rejected") throw emailOutcome.reason;
}

export type ReadyRecordingParams = {
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

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/** A row erased or deleted before Stream named its file; it must never come back READY. */
const ERASED_BEFORE_READY = {
  status: RecordingStatus.EXPIRED,
  removedAt: { not: null },
  streamRecordingId: null,
  streamUrlExpiresAt: null,
  transferredAt: null,
} satisfies Prisma.RecordingWhereInput;

/**
 * Stamps a ready file onto one erased pre-ready row of the meeting, which
 * stays EXPIRED, then deletes Stream's copy. A failed delete leaves the
 * filename on the row for expire-recordings. Null when no such row is left.
 */
export async function absorbIntoErasedRecording(params: {
  meetingId: string;
  streamCallId: string;
  filename: string;
  streamUrlExpiresAt: Date;
}): Promise<{ id: string; status: RecordingStatus } | null> {
  const { meetingId, filename } = params;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await prisma.recording.findFirst({
      where: { meetingId, ...ERASED_BEFORE_READY },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!candidate) return null;
    let absorbed;
    try {
      // The stamped expiry keeps one erased row from absorbing a second file.
      [absorbed] = await prisma.recording.updateManyAndReturn({
        where: { id: candidate.id, ...ERASED_BEFORE_READY },
        data: {
          streamRecordingId: filename,
          streamCallId: params.streamCallId,
          streamUrlExpiresAt: params.streamUrlExpiresAt,
        },
        select: {
          id: true,
          storagePath: true,
          streamCallId: true,
          streamRecordingId: true,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      // A concurrent delivery of this file stamped it onto a row first.
      const raced = await prisma.recording.findFirst({
        where: { meetingId, streamRecordingId: filename },
        select: { id: true, status: true },
      });
      if (!raced) throw error;
      return raced;
    }
    if (!absorbed) continue;
    const purged = await purgeExpiredRecordingAssets(absorbed);
    if (!purged.success) {
      streamLogger.warn("Erased recording's Stream copy left for expiry", {
        recordingId: absorbed.id,
        error: purged.error,
      });
    }
    return { id: absorbed.id, status: RecordingStatus.EXPIRED };
  }
  return null;
}

export async function createReadyRecordingOrAdoptRace(
  params: ReadyRecordingParams,
) {
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
    if (!isUniqueConflict(createError)) throw createError;

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
): Promise<{ id: string; status: RecordingStatus }> {
  const byFilename = await prisma.recording.findFirst({
    where: {
      meetingId: params.meetingId,
      streamRecordingId: params.filename,
    },
  });
  if (!byFilename) {
    const absorbed = await absorbIntoErasedRecording(params);
    if (absorbed) return absorbed;
  }
  const existingRecording =
    byFilename ??
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
  const { filename, url, start_time, end_time } = call_recording;

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
      // The orphan reconciler re-lists the call if its meeting appears later.
      throw new Error(
        permanentFailure(
          `recording_ready for unknown meeting (${streamCallId})`,
        ),
      );
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
        filename,
      });
      await clearRecordingFlag(meeting.id, streamCallId, endDate);
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
      await clearRecordingFlag(meeting.id, streamCallId, endDate);
    }

    const recordingId = recording.id;
    if (recording.status === RecordingStatus.EXPIRED) {
      streamLogger.info(
        "Recording ready for a removed recording; kept removed",
        {
          recordingId,
          sessionId: meeting.id,
        },
      );
      return;
    }
    streamLogger.info("Recording ready processed", {
      recordingId,
      sessionId: meeting.id,
      title,
      durationInMinutes,
    });

    await stageAndSendRecordingReadyNotifications(appointment, recordingId);
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
  recordingId: string,
  appointment: { id: string; organizationId?: string | null },
): Promise<void> {
  if (userIds.length === 0) return;
  const dashboardUrl = appointmentRecordingsHref(
    appointment.organizationId,
    appointment.id,
  );
  const stagedBells: Array<StagedTrigger | undefined> = [];
  let failureCount = 0;

  for (
    let i = 0;
    i < userIds.length;
    i += RECORDING_FAILED_NOTIFY_CONCURRENCY
  ) {
    const batch = userIds.slice(i, i + RECORDING_FAILED_NOTIFY_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((userId) =>
        notifyRecordingFailed(
          userId,
          {
            streamCallId,
            dashboardUrl,
          },
          `recording.failed:${recordingId}`,
          { deferAttempt: true },
        ),
      ),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") {
        stagedBells.push(r.value?.staged);
      } else {
        failureCount++;
      }
    }
  }

  // After the bells: the claim transaction holds the only pooled connection.
  const failedEmails = await stageDocumentAndRecordingEmailOnce(
    {
      entityId: streamCallId,
      userIds,
      kind: "RECORDING_FAILED",
      dashboardUrl,
    },
    {
      scope: "stream.recording-failed",
      key: (userId) => `recording-failed:${recordingId}:${userId}`,
      ttlMs: NOTICE_CLAIM_TTL_MS,
    },
  ).catch((error: unknown) => {
    streamLogger.warn("Recording-failed emails not staged", {
      streamCallId,
      recordingId,
      error: errorMessageOf(error),
    });
    return [];
  });

  if (failureCount > 0) {
    streamLogger.warn(
      `${failureCount}/${userIds.length} recording-failed notifications failed`,
      { streamCallId },
    );
  }

  await flushNotificationsAfter(
    {
      bells: stagedBells,
      emails: [
        {
          list: failedEmails,
          emailType: "RECORDING_FAILED",
          budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
        },
      ],
    },
    "recording.failed",
  );
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

    await clearRecordingFlag(
      meeting.id,
      streamCallId,
      eventTime(event.created_at),
    );

    const failedRow =
      (await prisma.recording.findFirst({
        where: {
          meetingId: meeting.id,
          streamCallId,
          status: RecordingStatus.FAILED,
        },
        select: { id: true },
      })) ??
      (await prisma.recording.create({
        select: { id: true },
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
      }));

    const appointment = meeting.occurrence.appointment;
    const userIds = appointment ? await getEventAttendeeIds(appointment) : [];

    if (appointment) {
      await notifyRecordingFailedChunked(
        userIds,
        streamCallId,
        failedRow.id,
        appointment,
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
