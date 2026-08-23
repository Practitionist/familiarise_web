"use server";

/**
 * Video Call Draining — called before entering OFFLINE maintenance phase.
 *
 * Finds active meeting sessions, stops any in-progress recordings,
 * notifies participants, and ends calls via Stream server SDK.
 */

import * as Sentry from "@sentry/nextjs";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  getStreamChatClient,
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { getChannelTypeFromId } from "@/lib/stream-channel-ids";
import { chunk, STREAM_CONCURRENCY_LIMIT } from "@/lib/stream/batch";
import { getEventChannelIdsForAppointment } from "@/lib/stream/appointment-channels";
import prisma from "@/lib/prisma";
import { notifyMaintenanceStarted } from "@/lib/novu/service";

/**
 * A session whose slot ended more than this ago cannot still have anyone in it;
 * it is an unreconciled row, and ending it here would corrupt its history.
 * reconcile-orphaned-sessions owns those.
 */
const LIVE_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Hard cap so a backlog can never hold the maintenance transition open. */
const MAX_DRAIN_BATCH = 200;


interface DrainResult {
  drained: number;
  recordingsStopped: number;
  /** Participants warned in-call. The broadcast is counted separately. */
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

  // #1134 P1-3 — `{ endedAt: null }` alone is not "active", it is "never
  // reconciled". At the time of the audit that matched 1,663 rows going back
  // months, each of which this loop would have ended on Stream serially and
  // stamped `endedReason: "maintenance"` — rewriting the history of sessions
  // that finished in February. Bound it to sessions that could plausibly still
  // have someone in them, and cap the batch so the maintenance transition cannot
  // be held open by a backlog.
  const now = new Date();
  const liveSince = new Date(now.getTime() - LIVE_SESSION_WINDOW_MS);
  const activeSessions = await prisma.meetingSession.findMany({
    where: {
      endedAt: null,
      slotOfAppointment: {
        endsAt: { gte: liveSince },
        // Bounded at BOTH ends. `endsAt >= liveSince` alone also matches every
        // FUTURE session, so a room opened early would be "drained": its call
        // ended and its slot stamped UNVERIFIED for a session that has not
        // happened yet. Only a session that has actually started can be live.
        startsAt: { lte: now },
      },
    },
    take: MAX_DRAIN_BATCH,
    orderBy: { createdAt: "desc" },
    include: {
      slotOfAppointment: {
        include: {
          user: { select: { id: true } },
          appointment: {
            include: {
              consultation: {
                include: {
                  consultationPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                  requestedBy: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                  requestedBy: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
              webinar: {
                include: {
                  webinarPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                },
              },
              class: {
                include: {
                  classPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
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

  if (activeSessions.length === 0) {
    return result;
  }

  // Collect all unique user IDs across all active sessions for bulk notification
  const allUserIds = new Set<string>();

  for (const session of activeSessions) {
    // Collect participant user IDs from the slot
    for (const user of session.slotOfAppointment.user) {
      allUserIds.add(user.id);
    }

    // Collect consultant user ID from the appointment
    const appointment = session.slotOfAppointment.appointment;
    const consultantUserId =
      appointment.consultation?.consultationPlan?.consultantProfile?.user?.id ??
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id ??
      appointment.webinar?.webinarPlan?.consultantProfile?.user?.id ??
      appointment.class?.classPlan?.consultantProfile?.user?.id;
    if (consultantUserId) allUserIds.add(consultantUserId);

    // Collect consultee user ID (for 1:1 appointments)
    const consulteeUserId =
      appointment.consultation?.requestedBy?.user?.id ??
      appointment.subscription?.requestedBy?.user?.id;
    if (consulteeUserId) allUserIds.add(consulteeUserId);

    // Step 1: Stop recording if active
    if (session.isRecording) {
      try {
        await RecordingService.stopRecording(session.streamCallId);
        await prisma.meetingSession.update({
          where: { id: session.id },
          data: { isRecording: false },
        });
        result.recordingsStopped++;
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" } });
        result.errors.push(
          `Stop recording ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 2: End call via Stream server SDK
    let endConfirmed = false;
    try {
      const client = getStreamVideoClient();
      const call = client.video.call(
        STREAM_CALL_TYPE,
        toCallId(session.streamCallId),
      );
      // #1134 — a `maintenance.draining` custom event used to be sent here, and
      // `notified` incremented when the API call succeeded. Nothing in the
      // client subscribes to `call.on("custom", …)`, so it warned nobody, and
      // `end()` fires microseconds later anyway — a toast would not have painted
      // even with a listener. Counting Stream's acknowledgement as a person
      // warned is the same fabricated metric this function is fixed for twenty
      // lines below, so the call and the counter are both gone rather than left
      // to imply a courtesy the product does not provide.
      //
      // Restore it together with a `call.on("custom")` subscriber in
      // MeetingRoom.tsx and a short delay before end() — not before.
      // #473 — fast-fail rather than eat a 30s timeout per session while Stream
      // is degraded; the maintenance window is exactly when that matters.
      await withStreamCircuitBreaker(() => call.end());
      endConfirmed = true;
    } catch (err) {
      result.errors.push(
        `End call ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Only record the session as ended if Stream CONFIRMED it. An unconfirmed
    // failure — a breaker trip, a timeout — means the call may still be live and
    // billing while our row claims it finished, and nothing would ever revisit
    // it. Leaving `endedAt` null keeps it visible to the next drain and to
    // reconcile-orphaned-sessions, which is what a still-running call needs.
    if (!endConfirmed) {
      continue;
    }

    // Step 3: Update DB session as ended.
    //
    // #1134 P1-3 — the slot's completionStatus was never set, so a drained
    // session sat SCHEDULED forever: the appointment never completed and the
    // consultant's earnings never became releasable. UNVERIFIED rather than
    // COMPLETED because we cut the call short — a human decides whether it
    // counts.
    const endedAt = new Date();
    await prisma.$transaction([
      prisma.meetingSession.update({
        where: { id: session.id },
        data: { endedAt, endedReason: "maintenance" },
      }),
      prisma.slotOfAppointment.update({
        where: { id: session.slotOfAppointmentId },
        data: { completionStatus: "UNVERIFIED", completedAt: endedAt },
      }),
    ]);

    result.drained++;
  }

  // Step 3b: freeze the chat channels for the affected appointments.
  //
  // #1134 P1-4 — nothing froze chat during maintenance. Stream Chat is a
  // separate SaaS, so messages kept flowing while the app was offline and unable
  // to sync or run moderation on any of them. Frozen keeps history readable and
  // refuses new sends.
  await freezeChannelsForSessions(activeSessions, result);

  // Step 4: Broadcast the maintenance notice.
  //
  // #1134 P1-3 — `result.notified = userIdList.length` used to be recorded here,
  // which was a fabricated metric: notifyMaintenanceStarted is a BROADCAST to
  // every user on the platform and takes no recipient list, so the count
  // described a targeted notification that never happened. `notified` now counts
  // the in-call custom events we actually delivered, above.
  const userIdList = Array.from(allUserIds);
  if (userIdList.length > 0) {
    try {
      await notifyMaintenanceStarted({
        phase: "OFFLINE",
        reason: "Platform maintenance starting. Active calls have been ended.",
      });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" }, level: "warning" });
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

/**
 * Freeze the chat channels attached to the appointments we just drained.
 *
 * #1134 P1-4 — a frozen channel keeps its history readable and refuses new
 * sends, which is exactly the maintenance posture: the app is going down and
 * cannot sync, moderate, or notify on anything sent meanwhile. Unfrozen again by
 * the maintenance exit path.
 *
 * Best-effort throughout. A chat freeze failing must never block the OFFLINE
 * transition, which is the whole point of the drain.
 */
async function freezeChannelsForSessions(
  sessions: { slotOfAppointment: { appointmentId: string } }[],
  result: DrainResult,
): Promise<void> {
  const appointmentIds = Array.from(
    new Set(sessions.map((s) => s.slotOfAppointment.appointmentId)),
  );
  if (appointmentIds.length === 0) return;

  try {
    const channelIds = await getEventChannelIdsForAppointment(appointmentIds);
    if (channelIds.length === 0) return;

    const chat = getStreamChatClient();
    // The breaker goes INSIDE the map, not around `Promise.allSettled`.
    // `allSettled` never rejects, so wrapping it meant the breaker recorded a
    // success however many channels failed — it could not trip during the very
    // outage it exists for — and not one failure reached `result.errors`. Per
    // channel, the breaker sees each real failure and each is reported.
    //
    // Chunked by STREAM_CONCURRENCY_LIMIT (2026-08-23): a bare
    // `channelIds.map(...)` fired every updatePartial simultaneously — up to
    // MAX_DRAIN_BATCH at once — and UpdateChannelPartial is capped at 300/min
    // app-wide, so a single drain could exhaust the same budget the daily
    // expire cron lives on. Sequential chunks of 10 keep each transition far
    // under the cap.
    for (const batch of chunk(channelIds, STREAM_CONCURRENCY_LIMIT)) {
      const outcomes = await Promise.allSettled(
        batch.map((channelId) =>
          withStreamCircuitBreaker(() =>
            chat
              .channel(getChannelTypeFromId(channelId), channelId)
              .updatePartial({ set: { frozen: true } }),
          ),
        ),
      );
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "rejected") {
          result.errors.push(
            `freeze ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
        }
      });
    }
  } catch (err) {
    result.errors.push(
      `Freeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Undo the maintenance freeze. Called from the maintenance exit path.
 *
 * #1134 — the drain froze group channels and nothing ever unfroze them. Stream
 * grants `use-frozen-channel` to no role by default, so those channels were
 * permanently unwritable by every user AND every admin, with no visible cause.
 * It lives in this PR rather than a later one precisely because this PR
 * introduces the freeze: shipping the two apart leaves a release window in which
 * maintenance silently bricks group chat.
 *
 * Scoped to sessions the drain actually ended (`endedReason: "maintenance"`)
 * within the recent window, so it cannot unfreeze a channel a moderator froze
 * deliberately. `updatePartial` rather than `update`: the latter is a full
 * replace and would delete `organizationId`, `appointmentId` and every other
 * custom field off the channel.
 */
export async function unfreezeChannelsAfterMaintenance(): Promise<{
  unfrozen: number;
  errors: string[];
}> {
  const result = { unfrozen: 0, errors: [] as string[] };

  const drained = await prisma.meetingSession.findMany({
    where: {
      endedReason: "maintenance",
      endedAt: { gte: new Date(Date.now() - LIVE_SESSION_WINDOW_MS) },
    },
    take: MAX_DRAIN_BATCH,
    select: { slotOfAppointment: { select: { appointmentId: true } } },
  });
  if (drained.length === 0) return result;

  try {
    const channelIds = await getEventChannelIdsForAppointment(
      Array.from(
        new Set(drained.map((s) => s.slotOfAppointment.appointmentId)),
      ),
    );
    if (channelIds.length === 0) return result;

    const chat = getStreamChatClient();
    // Chunked like the freeze path above — same 300/min UpdateChannelPartial
    // budget, same reason.
    for (const batch of chunk(channelIds, STREAM_CONCURRENCY_LIMIT)) {
      const outcomes = await Promise.allSettled(
        batch.map((channelId) =>
          withStreamCircuitBreaker(() =>
            chat
              .channel(getChannelTypeFromId(channelId), channelId)
              .updatePartial({ set: { frozen: false } }),
          ),
        ),
      );
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") result.unfrozen++;
        else
          result.errors.push(
            `unfreeze ${batch[i]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
      });
    }
  } catch (err) {
    result.errors.push(
      `Unfreeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}
