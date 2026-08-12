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

/**
 * Ceiling on the courtesy "we are draining" message, per session.
 *
 * Two seconds because it is worth almost nothing and runs up to
 * MAX_DRAIN_BATCH times serially: 200 × an unbounded call is how a five-second
 * maintenance transition becomes a hung one.
 */
const WARN_DEADLINE_MS = 2_000;

/**
 * Resolve/reject with the promise, or reject at the deadline — whichever first.
 *
 * The underlying request is NOT cancelled; nothing in the Stream SDK exposes an
 * abort signal here. This bounds how long we WAIT, which is the property the
 * drain needs.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

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
      // Give whoever is mid-sentence a reason for the disconnect. Best-effort,
      // and BOUNDED: this sits outside the circuit breaker, the video client
      // carries no timeout of its own (the 30s option is on the chat client),
      // and this loop runs up to MAX_DRAIN_BATCH times serially. An unbounded
      // courtesy message could hold the maintenance transition open for the
      // whole outage it is announcing.
      await withDeadline(
        call.sendCallEvent({
          custom: {
            type: "maintenance.draining",
            message:
              "This session is ending now for scheduled maintenance. You will be able to rejoin shortly.",
          },
        }),
        WARN_DEADLINE_MS,
      )
        .then(() => {
          result.notified++;
        })
        .catch(() => {});
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
    // `Promise.allSettled` never rejects, so wrapping it in the breaker meant the
    // breaker recorded a success no matter how many channels failed to freeze,
    // and not one failure reached `result.errors`. The freeze could fail
    // wholesale and report clean. Inspect the settled results and surface them.
    const settled = await withStreamCircuitBreaker(
      () =>
        Promise.allSettled(
          channelIds.map((channelId) =>
            chat
              .channel(getChannelTypeFromId(channelId), channelId)
              .updatePartial({ set: { frozen: true } }),
          ),
        ),
      () => [],
    );

    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (rejected.length > 0) {
      result.errors.push(
        `Freeze chat: ${rejected.length}/${channelIds.length} channel(s) failed — ` +
          rejected
            .slice(0, 3)
            .map((r) =>
              r.reason instanceof Error ? r.reason.message : String(r.reason),
            )
            .join("; "),
      );
    }
  } catch (err) {
    result.errors.push(
      `Freeze chat: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
