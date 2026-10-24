/**
 * Video Call Draining & Chat Freeze/Unfreeze for Maintenance Transitions.
 */

import * as Sentry from "@sentry/nextjs";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { StreamClient } from "@stream-io/node-sdk";
import { z } from "zod";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import {
  CLASS_PREFIX,
  getChannelTypeFromId,
  WEBINAR_PREFIX,
} from "@/lib/stream-channel-ids";
import {
  chunk,
  pause,
  STREAM_BATCH_PAUSE_MS,
  STREAM_CONCURRENCY_LIMIT,
} from "@/lib/stream/batch";
import prisma from "@/lib/prisma";
import { notifyMaintenanceStarted } from "@/lib/novu/service";

const LIVE_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_DRAIN_BATCH = 200;
const VENDOR_TIMEOUT_MS = 3_000;
const WORK_BUDGET_MS = 12_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maintenanceStreamClient() {
  const config = z
    .object({ apiKey: z.string().min(1), secret: z.string().min(1) })
    .parse({
      apiKey: process.env.NEXT_PUBLIC_STREAM_API_KEY,
      secret: process.env.STREAM_API_SECRET,
    });
  return new StreamClient(config.apiKey, config.secret, {
    timeout: VENDOR_TIMEOUT_MS,
  });
}

interface DrainResult {
  drained: number;
  recordingsStopped: number;
  errors: string[];
  remainingSessions: number;
  remainingChannelFreezes: number;
}

export async function drainActiveSessions(): Promise<DrainResult> {
  const result: DrainResult = {
    drained: 0,
    recordingsStopped: 0,
    errors: [],
    remainingSessions: 0,
    remainingChannelFreezes: 0,
  };

  const window = await currentMaintenanceWindow();
  if (!window) throw new Error("No active platform maintenance window");
  const deadline = Date.now() + WORK_BUDGET_MS;
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
    select: {
      id: true,
      streamCallId: true,
      appointmentOccurrenceId: true,
      isRecording: true,
    },
  });

  const client = activeSessions.length ? maintenanceStreamClient() : null;

  for (const session of activeSessions) {
    if (!client || Date.now() + 2 * VENDOR_TIMEOUT_MS > deadline) break;
    const claimed = await prisma.meeting.updateMany({
      where: {
        id: session.id,
        endedAt: null,
        streamCallId: session.streamCallId,
      },
      data: {
        maintenanceWindowId: window.id,
        maintenanceChannelRecoveredAt: null,
      },
    });
    if (!claimed.count) continue;
    const call = client.video.call(
      STREAM_CALL_TYPE,
      toCallId(session.streamCallId),
    );
    if (session.isRecording) {
      try {
        await call.stopRecording({ recording_type: "composite" });
        await prisma.meeting.update({
          where: { id: session.id },
          data: { isRecording: false },
        });
        result.recordingsStopped++;
      } catch (err) {
        result.errors.push(
          `Stop recording ${session.streamCallId}: ${messageOf(err)}`,
        );
        continue;
      }
    }

    let endConfirmed = false;
    try {
      await call.end();
      endConfirmed = true;
    } catch (err) {
      result.errors.push(`End call ${session.streamCallId}: ${messageOf(err)}`);
    }

    if (!endConfirmed) {
      continue;
    }

    const endedAt = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.meeting.update({
          where: { id: session.id },
          data: {
            endedAt,
            endedReason: "maintenance",
            maintenanceWindowId: window.id,
            maintenanceChannelRecoveredAt: null,
          },
        });
        await transitionOccurrenceCompletion(tx, {
          where: { id: session.appointmentOccurrenceId },
          to: "UNVERIFIED",
          data: { completedAt: endedAt },
          allowZero: true,
        });
      });
      result.drained++;
    } catch (err) {
      result.errors.push(
        `Record drained session ${session.id}: ${messageOf(err)}`,
      );
    }
  }

  result.remainingSessions = await prisma.meeting.count({
    where: {
      endedAt: null,
      occurrence: { endsAt: { gte: liveSince }, startsAt: { lte: now } },
    },
  });
  const channels = await syncMaintenanceChannels(window.id, true, deadline);
  result.remainingChannelFreezes = channels.remaining;
  result.errors.push(...channels.errors);
  if (result.remainingSessions || result.remainingChannelFreezes)
    result.errors.push(
      "Offline setup has a remaining backlog; retry activation.",
    );

  if (result.drained > 0) {
    try {
      await notifyMaintenanceStarted(
        {
          phase: "OFFLINE",
          reason:
            "Platform maintenance starting. Active calls may be interrupted.",
        },
        {
          deferAttempt: true,
          dedupeKey: `maintenance-started:${window.id}`,
        },
      );
    } catch (err) {
      result.errors.push(`Notification: ${messageOf(err)}`);
    }
  }

  if (result.errors.length)
    Sentry.captureException(new Error(result.errors[0]), {
      tags: { subsystem: "maintenance" },
      extra: { errorCount: result.errors.length },
    });

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
  deadline: number,
): Promise<Set<string>> {
  const succeeded = new Set<string>();
  if (!channelIds.length) return succeeded;
  const chat = maintenanceStreamClient().chat;
  const label = frozen ? "freeze" : "unfreeze";

  for (const [batchIdx, batch] of chunk(
    channelIds,
    STREAM_CONCURRENCY_LIMIT,
  ).entries()) {
    const pacing = batchIdx > 0 ? STREAM_BATCH_PAUSE_MS : 0;
    if (Date.now() + pacing + VENDOR_TIMEOUT_MS > deadline) break;
    if (pacing) await pause(pacing);
    const outcomes = await Promise.allSettled(
      batch.map((channelId) =>
        chat
          .channel(getChannelTypeFromId(channelId), channelId)
          .updateChannelPartial({ set: { frozen } }),
      ),
    );
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        succeeded.add(batch[i]);
      } else {
        errors.push(
          `${label} ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        );
      }
    });
  }

  return succeeded;
}

export async function unfreezeChannelsAfterMaintenance(): Promise<{
  unfrozen: number;
  errors: string[];
  remaining: number;
}> {
  const window = await currentMaintenanceWindow();
  if (!window) return { unfrozen: 0, errors: [], remaining: 0 };
  const result = await syncMaintenanceChannels(window.id, false);
  return {
    unfrozen: result.processed,
    errors: result.errors,
    remaining: result.remaining,
  };
}

function currentMaintenanceWindow() {
  return prisma.maintenanceWindow.findFirst({
    where: { organizationId: null, phase: { not: "OFF" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
}

/** Recovery includes uncertain freezes; only acknowledged recovery removes pending work. */
async function syncMaintenanceChannels(
  windowId: string,
  frozen: boolean,
  deadline = Date.now() + WORK_BUDGET_MS,
) {
  const errors: string[] = [];
  let processed = 0;
  let remaining = 0;
  try {
    const where = {
      maintenanceWindowId: windowId,
      ...(frozen
        ? { endedAt: { not: null }, maintenanceChannelFrozenAt: null }
        : { maintenanceChannelRecoveredAt: null }),
      occurrence: {
        appointment: {
          OR: [{ webinarId: { not: null } }, { classId: { not: null } }],
        },
      },
    };
    const meetings = await prisma.meeting.findMany({
      where,
      orderBy: { id: "asc" },
      take: MAX_DRAIN_BATCH,
      select: {
        id: true,
        occurrence: {
          select: {
            appointment: { select: { webinarId: true, classId: true } },
          },
        },
      },
    });
    const rows = meetings.map((meeting) => {
      const appointment = meeting.occurrence.appointment;
      return {
        id: meeting.id,
        channelIds: [
          ...(appointment.webinarId
            ? [`${WEBINAR_PREFIX}${appointment.webinarId}`]
            : []),
          ...(appointment.classId
            ? [`${CLASS_PREFIX}${appointment.classId}`]
            : []),
        ],
      };
    });
    if (frozen && rows.length && Date.now() + VENDOR_TIMEOUT_MS <= deadline)
      await prisma.meeting.updateMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          maintenanceWindowId: windowId,
        },
        data: { maintenanceChannelRecoveredAt: null },
      });
    const succeeded = await setChannelsFrozenState(
      [...new Set(rows.flatMap((row) => row.channelIds))],
      frozen,
      errors,
      deadline,
    );
    const ids = rows
      .filter((row) => row.channelIds.every((id) => succeeded.has(id)))
      .map((row) => row.id);
    if (ids.length) {
      const result = await prisma.meeting.updateMany({
        where: {
          id: { in: ids },
          maintenanceWindowId: windowId,
          ...(frozen
            ? { maintenanceChannelFrozenAt: null }
            : { maintenanceChannelRecoveredAt: null }),
        },
        data: frozen
          ? { maintenanceChannelFrozenAt: new Date() }
          : {
              maintenanceChannelFrozenAt: null,
              maintenanceChannelRecoveredAt: new Date(),
            },
      });
      processed = result.count;
    }
    remaining = await prisma.meeting.count({ where });
    if (remaining)
      errors.push(
        `${remaining} channel operation(s) remain; retry ${frozen ? "activation" : "recovery"}.`,
      );
  } catch (error) {
    errors.push(`${frozen ? "Freeze" : "Unfreeze"} chat: ${messageOf(error)}`);
  }
  return { processed, remaining, errors };
}
