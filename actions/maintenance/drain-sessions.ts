"use server";

/**
 * Video Call Draining & Chat Freeze/Unfreeze for Maintenance Transitions.
 */

import * as Sentry from "@sentry/nextjs";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  getStreamChatClient,
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { getChannelTypeFromId } from "@/lib/stream-channel-ids";
import {
  chunk,
  pause,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "@/lib/stream/batch";
import { getEventChannelIdsForAppointment } from "@/lib/stream/appointment-channels";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { notifyMaintenanceStarted } from "@/lib/novu/service";

const LIVE_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_DRAIN_BATCH = 200;

const CONSULTANT_USER_SELECT = {
  select: {
    consultantProfile: {
      select: { user: { select: { id: true } } },
    },
  },
} as const;

const REQUESTED_BY_USER_SELECT = {
  select: { user: { select: { id: true } } },
} as const;

interface DrainResult {
  drained: number;
  recordingsStopped: number;
  notified: number;
  errors: string[];
}

export async function drainActiveSessions(): Promise<DrainResult> {
  const result: DrainResult = {
    drained: 0,
    recordingsStopped: 0,
    notified: 0,
    errors: [],
  };

  const now = new Date();
  const liveSince = new Date(now.getTime() - LIVE_SESSION_WINDOW_MS);
  const activeSessions = await prisma.meeting.findMany({
    where: {
      endedAt: null,
      occurrence: {
        endsAt: { gte: liveSince },
        startsAt: { lte: now },
      },
    },
    take: MAX_DRAIN_BATCH,
    orderBy: { createdAt: "desc" },
    include: {
      occurrence: {
        include: {
          appointment: {
            include: {
              participants: {
                where: liveParticipant(),
                select: { userId: true },
              },
              consultation: {
                include: {
                  consultationPlan: CONSULTANT_USER_SELECT,
                  requestedBy: REQUESTED_BY_USER_SELECT,
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: CONSULTANT_USER_SELECT,
                  requestedBy: REQUESTED_BY_USER_SELECT,
                },
              },
              webinar: {
                include: {
                  webinarPlan: CONSULTANT_USER_SELECT,
                },
              },
              class: {
                include: {
                  classPlan: CONSULTANT_USER_SELECT,
                },
              },
            },
          },
        },
      },
    },
  });

  if (activeSessions.length === 0) {
    return result;
  }

  const allUserIds = new Set<string>();
  const drainedSessions: typeof activeSessions = [];

  for (const session of activeSessions) {
    for (const seat of session.occurrence.appointment.participants) {
      allUserIds.add(seat.userId);
    }

    const appointment = session.occurrence.appointment;
    const consultantUserId =
      appointment.consultation?.consultationPlan?.consultantProfile?.user?.id ??
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id ??
      appointment.webinar?.webinarPlan?.consultantProfile?.user?.id ??
      appointment.class?.classPlan?.consultantProfile?.user?.id;
    if (consultantUserId) allUserIds.add(consultantUserId);

    const consulteeUserId =
      appointment.consultation?.requestedBy?.user?.id ??
      appointment.subscription?.requestedBy?.user?.id;
    if (consulteeUserId) allUserIds.add(consulteeUserId);

    if (session.isRecording) {
      try {
        await RecordingService.stopRecording(session.streamCallId);
        await prisma.meeting.update({
          where: { id: session.id },
          data: { isRecording: false },
        });
        result.recordingsStopped++;
      } catch (err) {
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
          { tags: { subsystem: "maintenance" } },
        );
        result.errors.push(
          `Stop recording ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let endConfirmed = false;
    try {
      const client = getStreamVideoClient();
      const call = client.video.call(
        STREAM_CALL_TYPE,
        toCallId(session.streamCallId),
      );
      await withStreamCircuitBreaker(() => call.end());
      endConfirmed = true;
    } catch (err) {
      result.errors.push(
        `End call ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!endConfirmed) {
      continue;
    }

    const endedAt = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.meeting.update({
          where: { id: session.id },
          data: { endedAt, endedReason: "maintenance" },
        });
        await transitionOccurrenceCompletion(tx, {
          where: { id: session.appointmentOccurrenceId },
          to: "UNVERIFIED",
          data: { completedAt: endedAt },
          allowZero: true,
        });
      });
      result.drained++;
      drainedSessions.push(session);
    } catch (err) {
      result.errors.push(
        `Record drained session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await freezeChannelsForSessions(drainedSessions, result);

  if (allUserIds.size > 0) {
    try {
      await notifyMaintenanceStarted({
        phase: "OFFLINE",
        reason: "Platform maintenance starting. Active calls have been ended.",
      });
    } catch (err) {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "maintenance" }, level: "warning" },
      );
      result.errors.push(
        `Notification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "maintenance_sessions_drained",
      ...result,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}

async function setChannelsFrozenState(
  channelIds: string[],
  frozen: boolean,
  errors: string[],
): Promise<number> {
  const chat = getStreamChatClient();
  const label = frozen ? "freeze" : "unfreeze";
  let succeeded = 0;

  for (const [batchIdx, batch] of chunk(
    channelIds,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    if (batchIdx > 0) {
      await pause(STREAM_BATCH_PAUSE_MS);
    }
    const outcomes = await Promise.allSettled(
      batch.map((channelId) =>
        withStreamCircuitBreaker(() =>
          chat
            .channel(getChannelTypeFromId(channelId), channelId)
            .updatePartial({ set: { frozen } }),
        ),
      ),
    );
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        succeeded++;
      } else {
        errors.push(
          `${label} ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });
  }

  return succeeded;
}

async function freezeChannelsForSessions(
  sessions: { occurrence: { appointmentId: string } }[],
  result: DrainResult,
): Promise<void> {
  const appointmentIds = Array.from(
    new Set(sessions.map((s) => s.occurrence.appointmentId)),
  );
  if (appointmentIds.length === 0) return;

  try {
    const channelIds = await getEventChannelIdsForAppointment(appointmentIds);
    if (channelIds.length === 0) return;

    await setChannelsFrozenState(channelIds, true, result.errors);
  } catch (err) {
    result.errors.push(
      `Freeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type UnfreezeSource = "derived" | "none";

export async function unfreezeChannelsAfterMaintenance(): Promise<{
  unfrozen: number;
  errors: string[];
  source: UnfreezeSource;
}> {
  const result = {
    unfrozen: 0,
    errors: [] as string[],
    source: "none" as UnfreezeSource,
  };

  try {
    const channelIds = await deriveChannelsToUnfreeze();
    if (channelIds.length === 0) return result;
    result.source = "derived";

    result.unfrozen = await setChannelsFrozenState(
      channelIds,
      false,
      result.errors,
    );
  } catch (err) {
    result.errors.push(
      `Unfreeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

async function deriveChannelsToUnfreeze(): Promise<string[]> {
  const latestWindow = await prisma.maintenanceWindow?.findFirst?.({
    where: { organizationId: null },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  const since =
    latestWindow?.startedAt ?? new Date(Date.now() - LIVE_SESSION_WINDOW_MS);

  const drained = await prisma.meeting.findMany({
    where: {
      endedReason: "maintenance",
      endedAt: { gte: since },
    },
    orderBy: { endedAt: "desc" },
    take: MAX_DRAIN_BATCH,
    select: { occurrence: { select: { appointmentId: true } } },
  });
  if (drained.length === 0) return [];

  return getEventChannelIdsForAppointment(
    Array.from(new Set(drained.map((s) => s.occurrence.appointmentId))),
  );
}
