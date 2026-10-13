/**
 * Stream Recording Service
 * Provides methods to manage video call recordings
 */

import {
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
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

/**
 * Recording Service class for managing video call recordings
 */
/** Whether a session sync actually completed, and why not if it did not. */
export interface SyncOutcome {
  ok: boolean;
  reason?: "stream-unreachable" | "persist-failed";
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
   * Get recordings for a specific call from Stream
   * @param streamCallId The Stream call ID
   */
  /**
   * What Stream holds for a call, or `null` when Stream could not be asked.
   *
   * `null` is not an empty list. Returning `[]` for a transport failure made a
   * Stream outage indistinguishable from "this call has no recordings", so the
   * orphan reconciler counted an unreachable session as checked-and-empty and
   * reported success (#1280).
   */
  static async getCallRecordingsFromStream(
    streamCallId: string,
  ): Promise<StreamRecording[] | null> {
    try {
      const client = getStreamVideoClient();

      const callType = STREAM_CALL_TYPE;
      const callId = toCallId(streamCallId);

      const call = client.video.call(callType, callId);
      const response = await withStreamCircuitBreaker(() =>
        call.listRecordings(),
      );

      return response.recordings.map((r) => ({
        filename: r.filename,
        url: r.url,
        start_time: r.start_time,
        end_time: r.end_time,
        session_id: r.session_id,
      }));
    } catch (error) {
      streamLogger.error("Failed to get call recordings from Stream", error, {
        streamCallId,
      });
      return null;
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
   * Persist a single Stream recording segment and trigger idempotent ready notifications.
   * Existing rows re-run notification staging so transient outbox/provider errors self-heal on retry.
   */
  private static async syncSingleRecordingSegment(params: {
    sessionId: string;
    streamCallId: string;
    appointment: SyncableSession["occurrence"]["appointment"];
    streamRec: StreamRecording;
    syncedRecordings: RecordingRow[];
  }): Promise<void> {
    const {
      sessionId,
      streamCallId,
      appointment,
      streamRec,
      syncedRecordings,
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
    });

    if (existingRecording) {
      await stageAndSendRecordingReadyNotifications(
        appointment,
        existingRecording.id,
        streamCallId,
      ).catch((err) =>
        streamLogger.error(
          "Failed to retry recording ready notifications during sync",
          err,
          { recordingId: existingRecording.id, streamCallId },
        ),
      );
      streamLogger.info("Recording already exists, skipping creation", {
        recordingId: existingRecording.id,
        filename: streamRec.filename,
      });
      return;
    }

    const startDate = new Date(streamRec.start_time);
    const endDate = new Date(streamRec.end_time);
    const rawDurationMs = endDate.getTime() - startDate.getTime();
    const durationInMinutes = Number.isFinite(rawDurationMs)
      ? Math.max(0, Math.round(rawDurationMs / (1000 * 60)))
      : 0;

    const title = generateRecordingTitle(appointment, startDate);
    const streamUrlExpiresAt = streamCopyExpiresAt(endDate);

    const recording = await createReadyRecordingOrAdoptRace({
      meetingId: sessionId,
      streamCallId,
      filename: streamRec.filename,
      title,
      url: streamRec.url,
      durationInMinutes,
      startDate,
      streamUrlExpiresAt,
      organizationId: appointment?.organizationId ?? null,
    });

    syncedRecordings.push(recording);

    await stageAndSendRecordingReadyNotifications(
      appointment,
      recording.id,
      streamCallId,
    ).catch((err) =>
      streamLogger.error(
        "Failed to stage recording ready notifications during sync",
        err,
        { recordingId: recording.id, streamCallId },
      ),
    );

    streamLogger.info("Recording synced successfully", {
      recordingId: recording.id,
      sessionId,
      title,
      durationInMinutes,
    });
  }

  private static async syncSegmentsSequentially(
    segments: StreamRecording[],
    index: number,
    sessionId: string,
    streamCallId: string,
    appointment: SyncableSession["occurrence"]["appointment"],
    syncedRecordings: RecordingRow[],
  ): Promise<void> {
    if (index >= segments.length) return;
    await this.syncSingleRecordingSegment({
      sessionId,
      streamCallId,
      appointment,
      streamRec: segments[index],
      syncedRecordings,
    });
    return this.syncSegmentsSequentially(
      segments,
      index + 1,
      sessionId,
      streamCallId,
      appointment,
      syncedRecordings,
    );
  }

  /**
   * Mirrors one session's Stream recordings into the database and stages ready notifications.
   * Shared by user-triggered sync endpoints and `reconcile-orphaned-recordings`.
   */
  static async syncSessionRecordings(
    session: SyncableSession,
    syncedRecordings: RecordingRow[],
  ): Promise<SyncOutcome> {
    if (!session.streamCallId) return { ok: true };

    try {
      const streamRecordings = await this.getCallRecordingsFromStream(
        session.streamCallId,
      );

      if (streamRecordings === null)
        return { ok: false, reason: "stream-unreachable" };

      await this.syncSegmentsSequentially(
        streamRecordings,
        0,
        session.id,
        session.streamCallId,
        session.occurrence.appointment,
        syncedRecordings,
      );
      return { ok: true };
    } catch (sessionError) {
      streamLogger.error(
        "Failed to sync recordings for session",
        sessionError,
        {
          sessionId: session.id,
          streamCallId: session.streamCallId,
        },
      );
      // Swallowed so one bad session cannot abort a batch — but REPORTED, so a
      // caller that is deciding whether a recording is genuinely missing does
      // not read a persistence failure as an answer.
      return { ok: false, reason: "persist-failed" };
    }
  }

  /**
   * Sync recordings from Stream API for a consultant's sessions
   * Creates Recording records for any recordings not already in DB
   * @param consultantProfileId The consultant profile ID
   */
  static async syncRecordingsForConsultant(
    consultantProfileId: string,
  ): Promise<{ synced: number; recordings: RecordingRow[] }> {
    const syncedRecordings: RecordingRow[] = [];

    try {
      // Define the include for meeting sessions with full appointment details
      const meetingInclude = {
        occurrence: {
          include: {
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: true,
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: true,
                  },
                },
                trial: {
                  include: {
                    subscriptionPlan: true,
                  },
                },
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      } as const;

      // Get all Meetings for consultant's sessions (owned or collaborated)
      const meetings = await prisma.meeting.findMany({
        where: {
          streamCallId: { not: "" },
          occurrence: {
            appointment: {
              OR: [
                // Owned webinars
                {
                  webinar: {
                    webinarPlan: { consultantProfileId },
                  },
                },
                // Collaborated webinars
                {
                  webinar: {
                    webinarPlan: {
                      collaborators: {
                        some: { consultantProfileId, status: "ACCEPTED" },
                      },
                    },
                  },
                },
                // Owned classes
                {
                  class: {
                    classPlan: { consultantProfileId },
                  },
                },
                // Collaborated classes
                {
                  class: {
                    classPlan: {
                      collaborators: {
                        some: { consultantProfileId, status: "ACCEPTED" },
                      },
                    },
                  },
                },
                // Owned consultations
                {
                  consultation: {
                    consultationPlan: { consultantProfileId },
                  },
                },
                // Owned subscriptions
                {
                  subscription: {
                    subscriptionPlan: { consultantProfileId },
                  },
                },
                // Owned trials
                {
                  trial: {
                    subscriptionPlan: { consultantProfileId },
                  },
                },
              ],
            },
          },
        },
        include: meetingInclude,
      });

      streamLogger.info("Syncing recordings for consultant", {
        consultantProfileId,
        sessionCount: meetings.length,
      });

      // For each session, fetch recordings from Stream and sync
      for (const session of meetings) {
        await this.syncSessionRecordings(session, syncedRecordings);
      }

      streamLogger.info("Recording sync completed", {
        consultantProfileId,
        syncedCount: syncedRecordings.length,
      });

      return {
        synced: syncedRecordings.length,
        recordings: syncedRecordings,
      };
    } catch (error) {
      streamLogger.error("Failed to sync recordings for consultant", error, {
        consultantProfileId,
      });
      throw error;
    }
  }

  /**
   * Sync recordings from Stream API for a consultee's enrolled sessions
   * Creates Recording records for any recordings not already in DB
   * @param consulteeProfileId The consultee profile ID
   * @param userId The user ID (for payment lookup)
   */
  static async syncRecordingsForConsultee(
    consulteeProfileId: string,
    userId?: string,
  ): Promise<{ synced: number; recordings: RecordingRow[] }> {
    const syncedRecordings: RecordingRow[] = [];

    try {
      // Get the user ID from consultee profile if not provided
      let effectiveUserId = userId;
      if (!effectiveUserId) {
        const consulteeProfile = await prisma.consulteeProfile.findUnique({
          where: { id: consulteeProfileId },
          select: { user: { select: { id: true } } },
        });
        effectiveUserId = consulteeProfile?.user?.id;
      }

      if (!effectiveUserId) {
        streamLogger.warn("Could not find user for consultee profile", {
          consulteeProfileId,
        });
        return { synced: 0, recordings: [] };
      }

      // Find all paid enrollments through Payment records
      const paidEnrollments = await prisma.payment.findMany({
        where: {
          userId: effectiveUserId,
          paymentStatus: "SUCCEEDED",
          appointment: {
            OR: [
              { webinar: { isNot: null } },
              { class: { isNot: null } },
              { consultation: { isNot: null } },
              { subscription: { isNot: null } },
              { trial: { isNot: null } },
            ],
          },
        },
        include: {
          // #689 — net refunds so a fully-refunded enrollment doesn't re-sync recordings.
          refunds: { select: { amountPaise: true, status: true } },
          appointment: {
            include: {
              occurrences: {
                include: {
                  meeting: {
                    include: {
                      occurrence: {
                        include: {
                          appointment: {
                            include: {
                              consultation: {
                                include: {
                                  consultationPlan: true,
                                },
                              },
                              subscription: {
                                include: {
                                  subscriptionPlan: true,
                                },
                              },
                              trial: {
                                include: {
                                  subscriptionPlan: true,
                                },
                              },
                              webinar: {
                                include: {
                                  webinarPlan: true,
                                },
                              },
                              class: {
                                include: {
                                  classPlan: true,
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
            },
          },
        },
      });

      // Collect all meeting sessions from paid enrollments
      type MeetingWithDetails = NonNullable<
        (typeof paidEnrollments)[0]["appointment"]
      >["occurrences"][0]["meeting"];
      const meetings: NonNullable<MeetingWithDetails>[] = [];

      for (const payment of paidEnrollments) {
        if (!payment.appointment) continue;
        if (!isPaymentEntitled(payment)) continue; // #689 — skip fully-refunded
        for (const slot of payment.appointment.occurrences) {
          if (slot.meeting && slot.meeting.streamCallId) {
            meetings.push(slot.meeting);
          }
        }
      }

      // Deduplicate sessions by ID
      const uniqueSessions = Array.from(
        new Map(meetings.map((s) => [s.id, s])).values(),
      );

      streamLogger.info("Syncing recordings for consultee", {
        consulteeProfileId,
        sessionCount: uniqueSessions.length,
      });

      // For each session, fetch recordings from Stream and sync
      for (const session of uniqueSessions) {
        await this.syncSessionRecordings(session, syncedRecordings);
      }

      streamLogger.info("Recording sync completed for consultee", {
        consulteeProfileId,
        syncedCount: syncedRecordings.length,
      });

      return {
        synced: syncedRecordings.length,
        recordings: syncedRecordings,
      };
    } catch (error) {
      streamLogger.error("Failed to sync recordings for consultee", error, {
        consulteeProfileId,
      });
      throw error;
    }
  }
}
