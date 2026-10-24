/**
 * Stream Recording Service
 * Provides methods to manage video call recordings
 */

import {
  getStreamVideoClient,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { mapBounded } from "@/lib/stream/batch";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";
import { liveParticipant } from "@/lib/booking/participants";
import {
  generateRecordingTitle,
  streamCopyExpiresAt,
  type AppointmentWithOwnership,
} from "@/lib/stream/recording-utils";
import {
  discardDeclinedRecording,
  wasDeclinedDuringRecording,
} from "@/lib/stream/recording-decline";
import {
  createReadyRecordingOrAdoptRace,
  stageAndSendRecordingReadyNotifications,
} from "@/lib/stream/recording-handlers";
import type {
  RecordingRow,
  RecordingWithAccessControl,
} from "./recording-types";
import { recordingWithAccessControlInclude } from "./recording-types";

/** One composite file per call, the shape every reader of `Recording` expects. */
const RECORDING_TYPE = "composite";

/**
 * Check whether a presigned URL issued at `signedAtMs` with TTL `expiresSeconds`
 * has expired or is within its safety margin of expiring.
 */
export function isPresignedUrlExpired(
  signedAtMs: number,
  expiresSeconds: number,
  nowMs: number = Date.now(),
): boolean {
  if (!Number.isFinite(signedAtMs) || !Number.isFinite(expiresSeconds)) {
    return true;
  }
  if (expiresSeconds <= 0) return true;
  const expiresAtMs = signedAtMs + expiresSeconds * 1000;
  const safetyBufferMs = Math.min(60_000, Math.floor(expiresSeconds * 500));
  return nowMs >= expiresAtMs - safetyBufferMs;
}

// Types for Stream Recording API responses
export interface StreamRecording {
  filename: string;
  url: string;
  start_time: Date;
  end_time: Date;
  session_id: string;
}

export type StreamRecordingListing =
  | { status: "listed"; recordings: StreamRecording[] }
  | { status: "call-not-found" }
  | { status: "unavailable"; error: string };

/**
 * The slice of a Meeting the recording sync actually reads. Structural
 * rather than a Prisma payload type: the consultant and consultee paths reach
 * this point through different `include` shapes.
 */
export type SyncableSession = {
  id: string;
  streamCallId: string | null;
  occurrence: {
    appointment:
      | (NonNullable<Parameters<typeof generateRecordingTitle>[0]> &
          AppointmentWithOwnership &
          NonNullable<
            Parameters<typeof stageAndSendRecordingReadyNotifications>[0]
          > & {
            organizationId: string | null;
          })
      | null;
  };
};

/** Whether a session sync actually completed, and why not if it did not. */
export interface SyncOutcome {
  ok: boolean;
  reason?: "stream-unreachable" | "persist-failed";
}

/** A user sync reaches back this far; Stream holds no copy older than 14 days. */
const SYNC_WINDOW_DAYS = 30;
/** Meetings per sync call; `nextCursor` continues from the last one. */
export const SYNC_PAGE_SIZE = 25;

export interface UserSyncResult {
  synced: number;
  recordings: RecordingRow[];
  nextCursor: string | null;
}

const syncMeetingInclude = {
  occurrence: {
    include: {
      appointment: {
        include: {
          consultation: { include: { consultationPlan: true } },
          subscription: { include: { subscriptionPlan: true } },
          trial: { include: { subscriptionPlan: true } },
          webinar: { include: { webinarPlan: true } },
          class: { include: { classPlan: true } },
        },
      },
    },
  },
} as const;

const syncWindowStart = () =>
  new Date(Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);

/** Newest first, one row past the page so the caller learns whether more remain. */
function syncPageArgs(cursor: string | undefined) {
  return {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: SYNC_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

function splitSyncPage<T extends { id: string }>(
  rows: T[],
): { page: T[]; nextCursor: string | null } {
  const page = rows.slice(0, SYNC_PAGE_SIZE);
  return {
    page,
    nextCursor: rows.length > SYNC_PAGE_SIZE ? page[page.length - 1].id : null,
  };
}

export class RecordingService {
  /**
   * Start recording for a call
   * @param streamCallId The Stream call ID
   * @param userId The user ID who started the recording
   */
  static async startRecording(
    streamCallId: string,
    userId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = getStreamVideoClient();

      // #1134 P1-5 — one helper owns the `type:id` split; three sites here had
      // each reimplemented it and a fourth (the orphan reconciler) had forgotten.
      const callType = STREAM_CALL_TYPE;
      const callId = toCallId(streamCallId);

      // Get the call and start recording
      const call = client.video.call(callType, callId);
      // #473 — fast-fail while Stream is degraded instead of eating the 30s
      // client timeout. This one matters twice over: the maintenance drain calls
      // stopRecording in a loop of up to MAX_DRAIN_BATCH sessions, so an
      // unbounded call here holds the OFFLINE transition open for the duration
      // of the very outage it is transitioning for.
      // `recording_type` is a PATH segment of Stream's start/stop endpoints and
      // accepts composite | individual | raw; "default" was refused (#1580 §4 E2E).
      await withStreamCircuitBreaker(() =>
        call.startRecording({ recording_type: RECORDING_TYPE }),
      );

      streamLogger.info("Recording started via API", {
        streamCallId: callId,
        userId,
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to start recording";
      streamLogger.error("Failed to start recording", error, {
        streamCallId,
        userId,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Stop recording for a call
   * @param streamCallId The Stream call ID
   * @param userId Optional user ID who triggered the stop
   */
  static async stopRecording(
    streamCallId: string,
    userId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = getStreamVideoClient();

      const callType = STREAM_CALL_TYPE;
      const callId = toCallId(streamCallId);

      const call = client.video.call(callType, callId);
      await withStreamCircuitBreaker(() =>
        call.stopRecording({ recording_type: RECORDING_TYPE }),
      );

      streamLogger.info("Recording stopped via API", {
        streamCallId: callId,
        ...(userId ? { userId } : {}),
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to stop recording";
      streamLogger.error("Failed to stop recording", error, {
        streamCallId,
        ...(userId ? { userId } : {}),
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * What Stream holds for a call. `call-not-found` (404 / code 16) means every
   * copy is gone; `unavailable` means Stream was not asked or did not answer.
   * Failures are returned, not reported, so loop callers report once per run.
   */
  static async getCallRecordingsFromStream(
    streamCallId: string,
  ): Promise<StreamRecordingListing> {
    try {
      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        toCallId(streamCallId),
      );
      // The fallback answers an open breaker without a per-call Sentry event.
      const listed = await withStreamCircuitBreaker<StreamRecording[] | null>(
        async () =>
          (await call.listRecordings()).recordings.map((r) => ({
            filename: r.filename,
            url: r.url,
            start_time: r.start_time,
            end_time: r.end_time,
            session_id: r.session_id,
          })),
        () => null,
      );
      if (listed === null) {
        return { status: "unavailable", error: "Stream circuit is open" };
      }
      return { status: "listed", recordings: listed };
    } catch (error) {
      if (isExpectedStreamError(error)) return { status: "call-not-found" };
      const message = error instanceof Error ? error.message : String(error);
      streamLogger.warn("Stream recording listing failed", {
        streamCallId,
        error: scrubStringValue(message),
      });
      return { status: "unavailable", error: message };
    }
  }

  /**
   * Get a single recording by ID
   * @param recordingId The recording ID
   */
  static async getRecordingById(
    recordingId: string,
  ): Promise<RecordingWithAccessControl | null> {
    try {
      const recording = await prisma.recording.findUnique({
        where: { id: recordingId },
        include: {
          ...recordingWithAccessControlInclude,
          meeting: {
            include: {
              occurrence: {
                include: {
                  appointment: {
                    include: {
                      ...recordingWithAccessControlInclude.meeting.include
                        .occurrence.include.appointment.include,
                      consultation: { include: { consultationPlan: true } },
                      subscription: { include: { subscriptionPlan: true } },
                      trial: { include: { subscriptionPlan: true } },
                      participants: {
                        where: liveParticipant(),
                        select: { userId: true, role: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      return recording;
    } catch (error) {
      streamLogger.error("Failed to get recording by ID", error, {
        recordingId,
      });
      return null;
    }
  }

  /**
   * Update recording status
   * @param recordingId The recording ID
   * @param status The new status
   * @param additionalData Additional fields to update
   */
  static async updateRecordingStatus(
    recordingId: string,
    status: RecordingStatus,
    additionalData?: Partial<RecordingRow>,
  ): Promise<RecordingRow | null> {
    try {
      const recording = await prisma.recording.update({
        where: { id: recordingId },
        data: {
          status,
          ...additionalData,
        },
      });

      streamLogger.info("Recording status updated", {
        recordingId,
        status,
      });

      return recording;
    } catch (error) {
      streamLogger.error("Failed to update recording status", error, {
        recordingId,
        status,
      });
      return null;
    }
  }

  /**
   * Check if recording is enabled for an appointment type
   * @param appointmentId The appointment ID
   */
  static async isRecordingEnabledForAppointment(
    appointmentId: string,
  ): Promise<boolean> {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  recordingEnabled: true,
                },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  recordingEnabled: true,
                },
              },
            },
          },
          trial: {
            include: {
              subscriptionPlan: {
                select: {
                  recordingEnabled: true,
                },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  recordingEnabled: true,
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  recordingEnabled: true,
                },
              },
            },
          },
        },
      });

      if (!appointment) {
        return false;
      }

      return Boolean(
        appointment.webinar?.webinarPlan?.recordingEnabled ||
        appointment.class?.classPlan?.recordingEnabled ||
        appointment.consultation?.consultationPlan?.recordingEnabled ||
        appointment.subscription?.subscriptionPlan?.recordingEnabled ||
        appointment.trial?.subscriptionPlan?.recordingEnabled,
      );
    } catch (error) {
      streamLogger.error("Failed to check recording enabled", error, {
        appointmentId,
      });
      return false;
    }
  }

  /**
   * Persist one Stream segment. Ready notices go out only when `notify` is set;
   * their per-recipient claims make a repeat silent.
   */
  private static async syncSingleRecordingSegment(params: {
    sessionId: string;
    streamCallId: string;
    appointment: SyncableSession["occurrence"]["appointment"];
    streamRec: StreamRecording;
    syncedRecordings: RecordingRow[];
    notify: boolean;
  }): Promise<void> {
    const {
      sessionId,
      streamCallId,
      appointment,
      streamRec,
      syncedRecordings,
      notify,
    } = params;

    if (
      await wasDeclinedDuringRecording(
        sessionId,
        appointment,
        new Date(streamRec.end_time),
      )
    ) {
      await discardDeclinedRecording({
        meetingId: sessionId,
        streamCallId,
        sessionId: streamRec.session_id,
        filename: streamRec.filename,
      });
      return;
    }

    const existingRecording = await prisma.recording.findFirst({
      where: {
        meetingId: sessionId,
        streamRecordingId: streamRec.filename,
      },
      select: { id: true },
    });

    let recordingId: string;
    if (existingRecording) {
      recordingId = existingRecording.id;
    } else {
      const startDate = new Date(streamRec.start_time);
      const endDate = new Date(streamRec.end_time);
      const rawDurationMs = endDate.getTime() - startDate.getTime();
      const durationInMinutes = Number.isFinite(rawDurationMs)
        ? Math.max(0, Math.round(rawDurationMs / (1000 * 60)))
        : 0;

      const recording = await createReadyRecordingOrAdoptRace({
        meetingId: sessionId,
        streamCallId,
        filename: streamRec.filename,
        title: generateRecordingTitle(appointment, startDate),
        url: streamRec.url,
        durationInMinutes,
        startDate,
        streamUrlExpiresAt: streamCopyExpiresAt(endDate),
        organizationId: appointment?.organizationId ?? null,
      });
      syncedRecordings.push(recording);
      recordingId = recording.id;
    }

    if (!notify) return;
    await stageAndSendRecordingReadyNotifications(
      appointment,
      recordingId,
    ).catch((err) =>
      streamLogger.warn("Recording ready notifications not staged", {
        recordingId,
        streamCallId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /**
   * Mirrors one session's Stream recordings into the database. Shared by the
   * user sync (rows only) and `reconcile-orphaned-recordings` (`notify: true`).
   */
  static async syncSessionRecordings(
    session: SyncableSession,
    syncedRecordings: RecordingRow[],
    opts: { notify: boolean } = { notify: false },
  ): Promise<SyncOutcome> {
    if (!session.streamCallId) return { ok: true };

    try {
      const listing = await this.getCallRecordingsFromStream(
        session.streamCallId,
      );
      if (listing.status === "unavailable") {
        return { ok: false, reason: "stream-unreachable" };
      }
      if (listing.status === "call-not-found") return { ok: true };

      for (const streamRec of listing.recordings) {
        await this.syncSingleRecordingSegment({
          sessionId: session.id,
          streamCallId: session.streamCallId,
          appointment: session.occurrence.appointment,
          streamRec,
          syncedRecordings,
          notify: opts.notify,
        });
      }
      return { ok: true };
    } catch (sessionError) {
      streamLogger.warn("Failed to sync recordings for session", {
        sessionId: session.id,
        streamCallId: session.streamCallId,
        error:
          sessionError instanceof Error
            ? sessionError.message
            : String(sessionError),
      });
      // Swallowed so one bad session cannot abort a batch, but reported so a
      // caller never reads a persistence failure as "no recordings".
      return { ok: false, reason: "persist-failed" };
    }
  }

  /** One bounded page of a user sync: Stream calls run at most STREAM_CONCURRENCY_LIMIT wide. */
  private static async syncMeetingPage(
    page: SyncableSession[],
  ): Promise<RecordingRow[]> {
    const synced: RecordingRow[] = [];
    await mapBounded(page, (session) =>
      this.syncSessionRecordings(session, synced),
    );
    return synced;
  }

  /**
   * Sync a consultant's own and collaborated sessions from the last
   * SYNC_WINDOW_DAYS, newest first, SYNC_PAGE_SIZE meetings per call.
   */
  static async syncRecordingsForConsultant(
    consultantProfileId: string,
    opts: { cursor?: string } = {},
  ): Promise<UserSyncResult> {
    const accepted = {
      some: { consultantProfileId, status: "ACCEPTED" as const },
    };
    const rows = await prisma.meeting.findMany({
      where: {
        streamCallId: { not: "" },
        createdAt: { gte: syncWindowStart() },
        occurrence: {
          appointment: {
            OR: [
              { webinar: { webinarPlan: { consultantProfileId } } },
              { webinar: { webinarPlan: { collaborators: accepted } } },
              { class: { classPlan: { consultantProfileId } } },
              { class: { classPlan: { collaborators: accepted } } },
              { consultation: { consultationPlan: { consultantProfileId } } },
              { subscription: { subscriptionPlan: { consultantProfileId } } },
              { trial: { subscriptionPlan: { consultantProfileId } } },
            ],
          },
        },
      },
      include: syncMeetingInclude,
      ...syncPageArgs(opts.cursor),
    });
    const { page, nextCursor } = splitSyncPage(rows);
    const recordings = await this.syncMeetingPage(page);
    streamLogger.info("Recording sync completed", {
      consultantProfileId,
      sessionCount: page.length,
      syncedCount: recordings.length,
    });
    return { synced: recordings.length, recordings, nextCursor };
  }

  /**
   * Sync the sessions a consultee holds a live (not fully refunded) payment
   * for, over the same window and page bounds as the consultant sync.
   */
  static async syncRecordingsForConsultee(
    userId: string,
    opts: { cursor?: string } = {},
  ): Promise<UserSyncResult> {
    const paidByUser = {
      userId,
      paymentStatus: "SUCCEEDED" as const,
      deletedAt: null,
    };
    const rows = await prisma.meeting.findMany({
      where: {
        streamCallId: { not: "" },
        createdAt: { gte: syncWindowStart() },
        occurrence: { appointment: { payment: { some: paidByUser } } },
      },
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                ...syncMeetingInclude.occurrence.include.appointment.include,
                payment: {
                  where: paidByUser,
                  select: {
                    amount: true,
                    refunds: { select: { amountPaise: true, status: true } },
                  },
                },
              },
            },
          },
        },
      },
      ...syncPageArgs(opts.cursor),
    });
    const { page, nextCursor } = splitSyncPage(rows);
    // A fully refunded enrollment no longer reaches its recordings.
    const entitled = page.filter((meeting) =>
      meeting.occurrence.appointment.payment.some(isPaymentEntitled),
    );
    const recordings = await this.syncMeetingPage(entitled);
    streamLogger.info("Recording sync completed for consultee", {
      userId,
      sessionCount: entitled.length,
      syncedCount: recordings.length,
    });
    return { synced: recordings.length, recordings, nextCursor };
  }
}
