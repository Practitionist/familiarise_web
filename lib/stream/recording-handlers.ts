/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import { runAfterOrInline } from "@/lib/stream/run-after-or-inline";
import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { captureThrottled } from "@/lib/observability/throttled-capture";
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
  streamUrlExpiresAt,
} from "@/lib/stream/recording-utils";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { resolveAppointmentStoragePolicy } from "@/lib/stream/recording-storage-policy";
import { toCallId } from "@/lib/stream/call-cid";
import { isUniqueViolation } from "@/lib/db/pg-errors";

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
 * #1829 — a recording event for a call we have no `Meeting` row for.
 *
 * The same defect, and the same consequence, as the session handlers: a bare
 * `streamLogger.warn` is `console.warn`, which the function log strips. A
 * `recording_ready` that finds no room means the recording exists on Stream and
 * will be DELETED there in 14 days with nothing in Postgres to prove it ever
 * existed — the silent data-loss shape the whole transfer pipeline exists to
 * prevent, reported by a line nobody can see.
 *
 * Throttled per call: a mis-keyed room emits one event per recording lifecycle
 * step, and a live session with a camera on produces a burst.
 */
function reportOrphanedRecordingEvent(
  streamCallId: string,
  eventType: string,
): void {
  captureThrottled(
    `stream:no-meeting-row:${streamCallId}`,
    `Recording event for a call with no Meeting row — the recording will expire on Stream unrecorded (${eventType})`,
    {
      subsystem: "stream",
      level: "error",
      op: "webhook.no-meeting-row",
      extra: { streamCallId, eventType },
    },
  );
}

/**
 * Handle call.recording_started event
 * Updates Meeting to mark recording as active
 */
export async function handleRecordingStarted(
  event: StreamRecordingStartedEvent,
): Promise<void> {
  const { call_cid, user, created_at } = event;

  // #C10 — the one cid → id split, lib/stream/call-cid.ts. This file had four
  // hand-rolled copies; the helper is idempotent, so a bare id is unchanged.
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
      reportOrphanedRecordingEvent(streamCallId, "call.recording_started");
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
    //
    // #C4 — and `isRecording` is written through a conditional updateMany rather
    // than a bare `update`. The old read-then-write could resurrect a recording
    // that had already stopped: Stream retries these webhooks for 168 hours and
    // does not promise ordering, so a `recording_started` from the first ten
    // minutes of a call can be delivered AFTER the `recording_stopped` that
    // closed it. `isRecording` then reads true for a call that is recording
    // nothing, and — the part that actually costs money — nothing clears it: not
    // the stop (already delivered), not `recording_ready` (which only touches it
    // when it is true, and it now is), and not the end CAS, which is hours away
    // or, for a call that never ends, never. The operations team sees a meeting
    // that believes it is being recorded.
    //
    // A CAS on `isRecording: false` alone — the obvious shape — does NOT fix
    // this, and the reason is worth keeping: the state we are protecting the
    // call FROM is exactly `isRecording: false`, so that predicate is satisfied
    // by the post-stop row and the resurrection goes straight through. The fence
    // has to be the event's own clock. `recordingStartedAt` is the claim time of
    // the recording we last honoured, and the route only ever moves it forward,
    // so "this event is older than the claim we already hold" is precisely the
    // definition of a replay — and it is the one thing a duplicate delivery and a
    // genuine restart can be told apart by. A genuine restart is a DIFFERENT
    // event with a later `created_at`, which the `{ lt: startedAt }` branch
    // admits; the replay of the start we already recorded does not match.
    //
    // The cost of that precision: a genuine restart whose `created_at` lands
    // BEHIND the claim time we hold — clock skew between Stream's event clock and
    // the route's write — is dropped, and `isRecording` stays false until the
    // next stop/ready/failed or the end CAS. That is a cosmetic loss on a
    // flag the recording pipeline no longer depends on (#1615 made the ROUTE the
    // authority for the claim), and it is strictly better than the alternative of
    // never trusting the flag again.
    const startedAt = new Date(created_at);
    const { count } = await prisma.meeting.updateMany({
      where: {
        id: meeting.id,
        OR: [
          { recordingStartedAt: null },
          { recordingStartedAt: { lt: startedAt } },
        ],
      },
      data: {
        isRecording: true,
        ...(meeting.recordingStartedAt
          ? {}
          : { recordingStartedAt: startedAt }),
        ...(!meeting.recordingStartedBy && user?.id
          ? { recordingStartedBy: user.id }
          : {}),
      },
    });

    if (count === 0) {
      streamLogger.info(
        "Recording already started — a replayed start, not a new one",
        {
          sessionId: meeting.id,
          streamCallId,
          recordedClaimAt: meeting.recordingStartedAt?.toISOString() ?? null,
          eventAt: startedAt.toISOString(),
        },
      );
      return;
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

  // #C10 — the one cid → id split, lib/stream/call-cid.ts.
  const streamCallId = toCallId(call_cid);

  streamLogger.info("Recording stopped", { streamCallId });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId },
    });

    if (!meeting) {
      reportOrphanedRecordingEvent(streamCallId, "call.recording_stopped");
      streamLogger.warn(
        "Meeting session not found for recording stopped event",
        {
          streamCallId,
        },
      );
      return;
    }

    // #C4 — a transition, compare-and-set on the value the read observed, so a
    // repeated delivery of an event we have already applied writes nothing. Same
    // rule as the start above: a status change goes through `updateMany` with the
    // value it read in the `where`, never a bare `update`. Unlike the start, a
    // late stop is not fenced against a later restart — nothing records when a
    // recording stopped, and inventing that needs a column this fix does not
    // have. Recording-state correctness is carried by the route that starts it
    // and by the end CAS, both of which are unconditional.
    await prisma.meeting.updateMany({
      where: { id: meeting.id, isRecording: true },
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
      reportOrphanedRecordingEvent(streamCallId, "call.recording_ready");
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

    const appointment = meeting.occurrence.appointment;
    const title = generateRecordingTitle(appointment, startDate);

    // #1829 — the expiry clock, from the call rather than from the row write.
    //
    // Stream's own retention is 14 days measured from the CALL, and the app's
    // `cdn_expiration_seconds` is 1209600 to match. This used to be `now() + 14d`,
    // which is right for the webhook path (the skew is seconds) and badly wrong
    // for the orphan reconciler: a recording recovered on day 10 got an expiry of
    // day 24 while Stream deleted the bytes at day 14, so for ten days
    // `GET /api/stream/recordings/[recordingId]` passed its 410 gate and handed
    // the user a dead Stream URL. The helper takes the earlier of the two
    // bounds, so a fresh delivery is unchanged and a late recovery is capped to
    // what Stream will actually still have.
    const expiresAt = streamUrlExpiresAt(startDate);

    // Check if recording already exists (idempotency)
    const existingRecording = await prisma.recording.findFirst({
      where: {
        meetingId: meeting.id,
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

    // Create recording record. `organizationId` mirrors the parent
    // appointment's org tag so the org dashboard's recording library
    // can scope to "events I host" without joining through Appointment.
    //
    // #C6 — the `findFirst` above is a COURTESY read, not the guard. It is a
    // read-then-create with a window between the two, and this handler runs
    // twice for the same file whenever a delivery is retried — which is the
    // normal case, not the edge one, because the sweeper re-drives any event
    // carrying an error for 168 h. The unique on `Recording.streamRecordingId`
    // is what actually makes the write idempotent, so the loser of that race
    // gets a P2002, and the old code let it escape to the generic catch: the
    // event was stamped FAILED, the sweeper re-drove it, it raced again, and the
    // session spent three days failing a delivery that had already succeeded.
    // Adopting the existing row is the same posture as
    // `lib/webhooks/event-log.ts:195` — a unique violation here means "someone
    // already wrote what I was writing", never "this is a bug".
    let recording;
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
          streamUrlExpiresAt: expiresAt,
          meetingId: meeting.id,
          organizationId: appointment?.organizationId ?? null,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const adopted = await prisma.recording.findFirst({
        where: {
          meetingId: meeting.id,
          streamRecordingId: filename,
        },
        select: { id: true },
      });
      if (!adopted) throw error;
      streamLogger.info(
        "Recording already written by a concurrent delivery — adopting it",
        {
          recordingId: adopted.id,
          streamCallId,
          streamRecordingId: filename,
        },
      );
      return;
    }

    // Also update the meeting session to stop recording state if still active.
    // #C4 — the read said it was recording, so the `where` says so too; a bare
    // `update` here would clobber a restart that happened since.
    if (meeting.isRecording) {
      await prisma.meeting.updateMany({
        where: { id: meeting.id, isRecording: true },
        data: { isRecording: false },
      });
    }

    streamLogger.info("Recording created successfully", {
      recordingId: recording.id,
      sessionId: meeting.id,
      title,
      durationInMinutes,
    });

    // #899 — permanent-policy recordings start transferring at ready-time
    // instead of waiting for the near-expiry window. The transfer is the heavy
    // Stream-S3-download + Supabase-upload, so it runs via `after()` (not a bare
    // `void`) — on serverless an unawaited promise is killed once the webhook
    // response returns, which would drop the kick; `after()` keeps it alive past
    // the response. The 6-hourly cron sweep still backstops any kick that dies
    // with the function.
    // #1829 — all four plan arms, through the one resolver.
    //
    // This chain read only the `webinar` and `class` arms, while
    // `recordingStoragePolicy` exists on all four plan models and the MANUAL
    // transfer route already resolved all four through
    // `resolveAppointmentStoragePolicy`. So a PERMANENT consultation or
    // subscription plan was never auto-transferred here, was never counted by
    // the backlog alert (which reads the same filter), and WAS still flipped to
    // EXPIRED by `markExpiredRecordings` — which has no policy filter at all.
    // A customer who paid for permanent storage silently lost it, and the
    // console said the row was fine.
    const { policy: storagePolicy } =
      resolveAppointmentStoragePolicy(appointment);
    if (storagePolicy === "PERMANENT") {
      // #1589 M-P0-04 — inline when re-driven outside a request scope.
      await runAfterOrInline(() =>
        RecordingTransferService.queueRecordingTransfer(recording.id).catch(
          (err) =>
            streamLogger.error("Ready-time transfer kick threw", err, {
              recordingId: recording.id,
            }),
        ),
      );
    }

    // Build recipient list — every live seat holder of the booking (#1554)
    const userIds = await getEventAttendeeIds(appointment);

    if (userIds.length > 0) {
      let appointmentType = "consultation";
      let consultantName = "Unknown Consultant";

      if (appointment?.consultation) {
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

      // #1861 P2r — the Recording row above committed outside any open
      // transaction, so stage the outbox rows now (awaited, before the
      // response) rather than inside `after()`: an instance freeze between
      // the webhook response and `after()` firing used to lose the bell with
      // no trace. Only the delivery attempt is deferred, same serverless
      // rationale as the transfer kick above.
      const staged = await notifyRecordingAvailable(
        userIds,
        {
          // ADR 20 still holds: `userIds` here is the participant list from
          // getEventAttendeeIds, never an org roster, so the recordingUrl below
          // does not reach an operator. The scope tag is attribution only — it
          // does not widen who receives this.
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
        streamLogger.error("Failed to stage recording notification", err, {
          streamCallId,
        });
        return [];
      });
      const stagedRows = staged
        .map((r) => r.staged)
        .filter((row): row is StagedTrigger => Boolean(row));

      if (stagedRows.length > 0) {
        await runAfterOrInline(() =>
          Promise.all(
            stagedRows.map((row) =>
              attemptTrigger(row).catch((err) =>
                streamLogger.error(
                  "Failed to send recording notification",
                  err,
                  { streamCallId },
                ),
              ),
            ),
          ),
        );
      }
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
  const { call_cid, error: eventError, created_at } = event;

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
      reportOrphanedRecordingEvent(streamCallId, "call.recording_failed");
      streamLogger.warn(
        "Meeting session not found for recording failed event",
        {
          streamCallId,
        },
      );
      return;
    }

    // #C4 — a transition, CAS on the value the read observed.
    await prisma.meeting.updateMany({
      where: { id: meeting.id, isRecording: true },
      data: {
        isRecording: false,
      },
    });

    // Create a failed recording record for tracking. Stamp the parent
    // appointment's `organizationId` so the failure shows up under the
    // host org's dashboard rather than orphaning under "personal".
    //
    // #1589 M-P1-06 — one FAILED row per call: a sweeper re-drive of the
    // same event used to mint another (a failed event carries no recording id).
    // That fix was a `findFirst` guard and nothing more, so it held only when
    // nothing raced: two deliveries of the same event (Stream redelivers, and the
    // sweeper re-drives anything carrying an error for 168 h) both read "no
    // FAILED row" and both wrote one.
    //
    // #C5 — the guard is now the DATABASE, and the way to get a database to
    // dedupe is to give it something to dedupe on. `Recording.streamRecordingId`
    // is `@unique` and was left null precisely because a failed recording has no
    // filename, which is why the column could not do this job before. So a
    // deterministic value is written instead: the call, plus the event's own
    // `created_at`, which is stable across every re-drive (the sweeper replays
    // the STORED payload, it does not re-fetch from Stream). Two consequences,
    // both intended:
    //
    //   - the same failure delivered twice collides on the unique and is adopted,
    //     exactly as `recording_ready` now does (C6);
    //   - a call that genuinely failed twice — record, fail, record, fail — gets
    //     two rows, because the second event has a later `created_at`. Deduping
    //     on the call alone would have thrown away the second failure.
    //
    // The `failed:` prefix namespaces the value so it can never collide with a
    // real Stream filename, and so nothing that goes looking for "a recording we
    // have" (`recording-service.syncSessionRecordings`, the orphan reconciler)
    // mistakes this row for a segment it already has. It is NOT a Stream id and
    // nothing may be fetched with it — the row's `recordingUrl` is "" and its
    // status is FAILED, which is the whole of its meaning.
    //
    // What this costs, stated plainly: the column now holds a value that is not
    // a Stream id on FAILED rows. The honest fix is a `@@unique([meetingId,
    // status, recordedAt])`-style constraint or a dedicated failure table, both
    // of which are schema changes another owner has to make — see the report. A
    // deterministic string in an existing unique column is the least-invasive
    // correct thing available today.
    // The event's own clock, not the processing clock: "when the recording
    // failed" is a fact about the call, and the re-drive that would have
    // written a second row with a later `new Date()` no longer can.
    const failureKey = `failed:${streamCallId}@${created_at}`;
    let recordedFailure = false;
    try {
      await prisma.recording.create({
        data: {
          title: "Recording Failed",
          recordingUrl: "",
          durationInMinutes: 0,
          recordedAt: new Date(created_at),
          streamRecordingId: failureKey,
          streamCallId,
          status: RecordingStatus.FAILED,
          meetingId: meeting.id,
          organizationId:
            meeting.occurrence.appointment?.organizationId ?? null,
        },
      });
      recordedFailure = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      streamLogger.info(
        "Recording failure already recorded — not writing it twice",
        { meetingId: meeting.id, streamCallId, failureKey },
      );
    }

    // #C5 — the early return. The fan-out below sends a real notification to
    // every seat holder of the booking, so running it on every dispatch meant a
    // re-driven failure mailed the same people the same "we could not record
    // your session" message again, once per attempt, for three days. It belongs
    // to the WRITE, not to the delivery: the row exists so the failure is
    // visible in the recordings library, and the bell is the human half of that.
    // A second dispatch for a failure we already both recorded and announced has
    // nothing left to do, and skipping the rest of the handler is what keeps the
    // re-drive from costing anything.
    if (!recordedFailure) return;

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
