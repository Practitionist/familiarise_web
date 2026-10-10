/**
 * Stream Recording Service
 * Provides methods to manage video call recordings
 */

import {
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { Prisma, RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";
import { liveParticipant } from "@/lib/booking/participants";
import {
  hiddenFromLateJoiner,
  lateJoinRecordingAccess,
} from "@/lib/stream/late-join-recordings";
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
  webinarRecordingScope,
  webinarRecordingWhere,
  type WebinarRecordingScope,
} from "@/lib/stream/recording-attendee-scope";
import type {
  RecordingRow,
  ConsultantRecordingWithDetails,
  ConsulteeRecordingWithDetails,
  RecordingWithAccessControl,
  WebinarPlanRecordingWithDetails,
  ClassPlanRecordingWithDetails,
} from "./recording-types";
import {
  consultantRecordingInclude,
  consulteeRecordingInclude,
  recordingWithAccessControlInclude,
  webinarPlanRecordingInclude,
  classPlanRecordingInclude,
} from "./recording-types";

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
          AppointmentWithOwnership & {
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

export type ConsultantRecordingFilterType =
  "webinar" | "class" | "consultation" | "subscription" | "trial";

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
   * Get recordings for a meeting session from database
   * @param meetingId The meeting session ID
   */
  static async getSessionRecordings(
    meetingId: string,
  ): Promise<RecordingRow[]> {
    try {
      const recordings = await prisma.recording.findMany({
        where: {
          meetingId,
          status: {
            notIn: ["FAILED", "EXPIRED"],
          },
        },
        orderBy: {
          recordedAt: "desc",
        },
      });

      return recordings;
    } catch (error) {
      streamLogger.error("Failed to get session recordings", error, {
        meetingId,
      });
      return [];
    }
  }

  /**
   * Get all recordings for a webinar plan
   * @param webinarPlanId The webinar plan ID
   */
  static async getWebinarPlanRecordings(
    webinarPlanId: string,
  ): Promise<WebinarPlanRecordingWithDetails[]> {
    try {
      const recordings = await prisma.recording.findMany({
        where: {
          meeting: {
            occurrence: {
              appointment: {
                webinar: {
                  webinarPlanId,
                },
              },
            },
          },
          status: {
            notIn: ["FAILED", "EXPIRED"],
          },
        },
        include: webinarPlanRecordingInclude,
        orderBy: {
          recordedAt: "desc",
        },
      });

      return recordings;
    } catch (error) {
      streamLogger.error("Failed to get webinar plan recordings", error, {
        webinarPlanId,
      });
      return [];
    }
  }

  /**
   * Get all recordings for a class plan
   * @param classPlanId The class plan ID
   */
  static async getClassPlanRecordings(
    classPlanId: string,
  ): Promise<ClassPlanRecordingWithDetails[]> {
    try {
      const recordings = await prisma.recording.findMany({
        where: {
          meeting: {
            occurrence: {
              appointment: {
                class: {
                  classPlanId,
                },
              },
            },
          },
          status: {
            notIn: ["FAILED", "EXPIRED"],
          },
        },
        include: classPlanRecordingInclude,
        orderBy: {
          recordedAt: "desc",
        },
      });

      return recordings;
    } catch (error) {
      streamLogger.error("Failed to get class plan recordings", error, {
        classPlanId,
      });
      return [];
    }
  }

  /**
   * Get all recordings for a consultant
   * @param consultantProfileId The consultant profile ID
   * @param filters Optional filters for type, status, search, and pagination
   */
  static async getConsultantRecordings(
    consultantProfileId: string,
    filters?: {
      type?: ConsultantRecordingFilterType;
      status?: RecordingStatus;
      search?: string;
      page?: number;
      limit?: number;
      /**
       * #1166 ORG-6 — view scope on Recording.organizationId (indexed).
       * `null` pins personal (B2C), a string pins that org, omitted = no
       * filter. Same convention as consultant-earnings-analytics.
       */
      organizationId?: string | null;
    },
  ): Promise<{ recordings: ConsultantRecordingWithDetails[]; total: number }> {
    try {
      const page = filters?.page ?? 1;
      const limit = filters?.limit ?? 12;

      // Build type-specific conditions based on filter
      const typeConditions: Prisma.RecordingWhereInput[] = [];

      if (!filters?.type || filters.type === "webinar") {
        // Owner's webinar recordings
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                webinar: {
                  webinarPlan: { consultantProfileId },
                },
              },
            },
          },
        });
        // Collaborator's webinar recordings
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                webinar: {
                  webinarPlan: {
                    collaborators: {
                      some: { consultantProfileId, status: "ACCEPTED" },
                    },
                  },
                },
              },
            },
          },
        });
      }

      if (!filters?.type || filters.type === "class") {
        // Owner's class recordings
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                class: {
                  classPlan: { consultantProfileId },
                },
              },
            },
          },
        });
        // Collaborator's class recordings
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                class: {
                  classPlan: {
                    collaborators: {
                      some: { consultantProfileId, status: "ACCEPTED" },
                    },
                  },
                },
              },
            },
          },
        });
      }

      if (!filters?.type || filters.type === "consultation") {
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                consultation: {
                  consultationPlan: { consultantProfileId },
                },
              },
            },
          },
        });
      }

      if (!filters?.type || filters.type === "subscription") {
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                subscription: {
                  subscriptionPlan: { consultantProfileId },
                },
              },
            },
          },
        });
      }

      if (!filters?.type || filters.type === "trial") {
        typeConditions.push({
          meeting: {
            occurrence: {
              appointment: {
                trial: {
                  subscriptionPlan: { consultantProfileId },
                },
              },
            },
          },
        });
      }

      // Build status filter - use provided status or default exclusions
      const statusFilter = filters?.status
        ? { status: filters.status }
        : { status: { notIn: ["FAILED", "EXPIRED"] as RecordingStatus[] } };

      // Build search filter
      const searchFilter = filters?.search
        ? { title: { contains: filters.search, mode: "insensitive" as const } }
        : {};

      const where = {
        OR: typeConditions,
        ...statusFilter,
        ...searchFilter,
        ...(filters?.organizationId !== undefined
          ? { organizationId: filters.organizationId }
          : {}),
      };

      const [recordings, total] = await Promise.all([
        prisma.recording.findMany({
          where,
          include: consultantRecordingInclude,
          orderBy: {
            recordedAt: "desc",
          },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.recording.count({ where }),
      ]);

      return { recordings, total };
    } catch (error) {
      streamLogger.error("Failed to get consultant recordings", error, {
        consultantProfileId,
      });
      return { recordings: [], total: 0 };
    }
  }

  /**
   * Recording entitlements from the user's payments and live seats: the webinar
   * scope, paid class plans, and entitled 1:1 appointments.
   */
  static async getPaidPlanIds(userId: string): Promise<{
    webinarScope: WebinarRecordingScope;
    classPlanIds: string[];
    appointmentIds: string[];
  }> {
    const [enrolledAppointments, seatRows] = await Promise.all([
      prisma.payment.findMany({
        where: {
          userId,
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
        select: {
          amount: true,
          appointmentId: true,
          refunds: { select: { amountPaise: true, status: true } },
          appointment: {
            select: {
              id: true,
              webinar: {
                select: {
                  webinarPlanId: true,
                  webinarPlan: {
                    select: { shareRecordingsWithAllAttendees: true },
                  },
                },
              },
              class: { select: { classPlanId: true } },
              consultation: { select: { id: true } },
              subscription: { select: { id: true } },
              trial: { select: { id: true } },
            },
          },
        },
      }),
      prisma.appointmentParticipant?.findMany?.({
        where: {
          userId,
          ...liveParticipant(),
        },
        select: {
          appointmentId: true,
          appointment: {
            select: {
              id: true,
              payment: {
                where: { userId, paymentStatus: "SUCCEEDED" },
                select: {
                  amount: true,
                  refunds: { select: { amountPaise: true, status: true } },
                },
              },
              webinar: {
                select: {
                  webinarPlanId: true,
                  webinarPlan: {
                    select: { shareRecordingsWithAllAttendees: true },
                  },
                },
              },
              class: { select: { classPlanId: true } },
              consultation: { select: { id: true } },
              subscription: { select: { id: true } },
              trial: { select: { id: true } },
            },
          },
        },
      }) ?? Promise.resolve([]),
    ]);

    // #689 — drop fully-refunded purchases before deriving entitled plans; a
    // SUCCEEDED payment whose refunds cover it no longer grants recording access.
    const entitled = enrolledAppointments.filter(isPaymentEntitled);
    const entitledAppointmentIds = new Set(
      entitled
        .map((p) => p.appointment?.id ?? p.appointmentId)
        .filter((id): id is string => Boolean(id)),
    );
    const refundedAppointmentIds = new Set(
      enrolledAppointments
        .filter((p) => !isPaymentEntitled(p))
        .map((p) => p.appointment?.id ?? p.appointmentId)
        .filter(
          (id): id is string =>
            typeof id === "string" && !entitledAppointmentIds.has(id),
        ),
    );
    const entitledSeats = seatRows.filter((seat) => {
      const apptId = seat.appointment?.id ?? seat.appointmentId;
      if (apptId && refundedAppointmentIds.has(apptId)) return false;
      const seatPayments = (
        seat.appointment as
          | {
              payment?: Array<Parameters<typeof isPaymentEntitled>[0]>;
            }
          | null
          | undefined
      )?.payment;
      if (Array.isArray(seatPayments) && seatPayments.length > 0) {
        return seatPayments.some(isPaymentEntitled);
      }
      return true;
    });
    const combined = [...entitled, ...entitledSeats];

    const webinarScope = webinarRecordingScope(
      combined.flatMap((e) => {
        const webinar = e.appointment?.webinar;
        const appointmentId = e.appointment?.id ?? e.appointmentId;
        return webinar && appointmentId
          ? [
              {
                appointmentId,
                webinarPlanId: webinar.webinarPlanId,
                shareRecordingsWithAllAttendees:
                  webinar.webinarPlan.shareRecordingsWithAllAttendees,
              },
            ]
          : [];
      }),
    );
    const classPlanIds = Array.from(
      new Set(
        combined
          .map((e) => e.appointment?.class?.classPlanId)
          .filter((id): id is string => !!id),
      ),
    );
    const appointmentIds = Array.from(
      new Set(
        combined
          .filter(
            (e) =>
              e.appointment?.consultation ||
              e.appointment?.subscription ||
              e.appointment?.trial,
          )
          .map((e) => e.appointment?.id ?? e.appointmentId)
          .filter((id): id is string => !!id),
      ),
    );

    return { webinarScope, classPlanIds, appointmentIds };
  }

  private static buildOneToOneTypeFilter(
    type?: ConsultantRecordingFilterType,
  ): Prisma.AppointmentWhereInput {
    if (type === "consultation") return { consultation: { isNot: null } };
    if (type === "subscription") return { subscription: { isNot: null } };
    if (type === "trial") return { trial: { isNot: null } };
    return {};
  }

  private static buildConsulteeWhereConditions(params: {
    type?: ConsultantRecordingFilterType;
    webinarScope: WebinarRecordingScope;
    classPlanIds: string[];
    appointmentIds: string[];
    purchasedRecordingIds: string[];
  }): Prisma.RecordingWhereInput[] {
    const {
      type,
      webinarScope,
      classPlanIds,
      appointmentIds,
      purchasedRecordingIds,
    } = params;
    const whereConditions: Prisma.RecordingWhereInput[] = [];

    if (!type || type === "webinar") {
      whereConditions.push(...webinarRecordingWhere(webinarScope));
    }

    if ((!type || type === "class") && classPlanIds.length > 0) {
      whereConditions.push({
        meeting: {
          occurrence: {
            appointment: {
              class: { classPlanId: { in: classPlanIds } },
            },
          },
        },
      });
    }

    const includeOneToOne =
      !type ||
      type === "consultation" ||
      type === "subscription" ||
      type === "trial";
    if (includeOneToOne && appointmentIds.length > 0) {
      whereConditions.push({
        meeting: {
          occurrence: {
            appointment: {
              id: { in: appointmentIds },
              ...this.buildOneToOneTypeFilter(type),
            },
          },
        },
      });
    }

    if (!type && purchasedRecordingIds.length > 0) {
      whereConditions.push({
        id: { in: purchasedRecordingIds },
      });
    }

    return whereConditions;
  }

  /**
   * Get all recordings for a consultee (paid enrollments only)
   * @param userId The user ID (for payment lookup)
   * @param filters Optional filters for type
   */
  static async getConsulteeRecordings(
    userId: string,
    filters?: {
      type?: "webinar" | "class" | "consultation" | "subscription" | "trial";
      organizationId?: string | null;
    },
  ): Promise<ConsulteeRecordingWithDetails[]> {
    try {
      const [{ webinarScope, classPlanIds, appointmentIds = [] }, purchases] =
        await Promise.all([
          this.getPaidPlanIds(userId),
          prisma.recordingPurchase?.findMany?.({
            where: { buyerId: userId, status: "SUCCEEDED" },
            select: { recordingId: true },
          }) ?? Promise.resolve([]),
        ]);

      const purchasedRecordingIds = purchases
        .map((p) => p.recordingId)
        .filter((id): id is string => Boolean(id));

      const whereConditions = this.buildConsulteeWhereConditions({
        type: filters?.type,
        webinarScope,
        classPlanIds,
        appointmentIds,
        purchasedRecordingIds,
      });

      // If no valid enrollments found, return empty array
      if (whereConditions.length === 0) {
        return [];
      }

      // Fetch recordings for enrolled plans
      const recordings = await prisma.recording.findMany({
        where: {
          OR: whereConditions,
          status: {
            notIn: ["FAILED", "EXPIRED"],
          },
          ...(filters?.organizationId !== undefined
            ? { organizationId: filters.organizationId }
            : {}),
        },
        include: consulteeRecordingInclude,
        orderBy: {
          recordedAt: "desc",
        },
      });

      if (
        typeof (
          prisma.appointmentParticipant as { findMany?: unknown } | undefined
        )?.findMany === "function"
      ) {
        const lateJoin = await lateJoinRecordingAccess(userId);
        return recordings.filter(
          (rec) =>
            !hiddenFromLateJoiner(
              rec as unknown as Parameters<typeof hiddenFromLateJoiner>[0],
              lateJoin,
            ),
        );
      }

      return recordings;
    } catch (error) {
      streamLogger.error("Failed to get consultee recordings", error, {
        userId,
      });
      return [];
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
   * Get the current recording state for a meeting session
   * @param meetingId The meeting session ID
   */
  static async getRecordingState(meetingId: string): Promise<{
    isRecording: boolean;
    startedAt: Date | null;
    startedBy: string | null;
  }> {
    try {
      const session = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: {
          isRecording: true,
          recordingStartedAt: true,
          recordingStartedBy: true,
        },
      });

      if (!session) {
        return { isRecording: false, startedAt: null, startedBy: null };
      }

      return {
        isRecording: session.isRecording,
        startedAt: session.recordingStartedAt,
        startedBy: session.recordingStartedBy,
      };
    } catch (error) {
      streamLogger.error("Failed to get recording state", error, {
        meetingId,
      });
      return { isRecording: false, startedAt: null, startedBy: null };
    }
  }

  /**
   * Mirrors one session's Stream recordings into the database.
   *
   * The consultant and consultee sync paths held byte-identical copies of this
   * loop, so the #1166 ORG-6 org-tag fix had to be made twice — and the gap it
   * closed existed twice for the same reason. One writer now.
   *
   * Failures are swallowed per session, deliberately: one unreachable call must
   * not abandon the rest of the sync.
   *
   * Public since #1270 for a third caller,
   * `scripts/stream/reconcile-orphaned-recordings.ts`. It stays the ONLY
   * writer: the nightly reconciliation decides WHICH sessions to look at, this
   * decides what a Stream recording becomes in our database. A second copy of
   * the loop is how the org-tag gap above came to exist twice.
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

      // Could not ask Stream. Returning here rather than treating it as an
      // empty result is the whole point: a caller deciding whether a recording
      // is missing must be able to tell "Stream says there is nothing" from
      // "Stream did not answer".
      if (streamRecordings === null)
        return { ok: false, reason: "stream-unreachable" };

      const appointment = session.occurrence.appointment;
      for (const streamRec of streamRecordings) {
        if (
          await wasDeclinedDuringRecording(
            session.id,
            appointment,
            new Date(streamRec.end_time),
          )
        ) {
          await discardDeclinedRecording({
            meetingId: session.id,
            streamCallId: session.streamCallId,
            sessionId: streamRec.session_id,
            filename: streamRec.filename,
          });
          continue;
        }

        // Check if recording already exists (by filename/streamRecordingId)
        const existingRecording = await prisma.recording.findFirst({
          where: {
            meetingId: session.id,
            streamRecordingId: streamRec.filename,
          },
        });

        if (existingRecording) {
          streamLogger.info("Recording already exists, skipping", {
            recordingId: existingRecording.id,
            filename: streamRec.filename,
          });
          continue;
        }

        // Calculate duration in minutes (clamped to >= 0)
        const startDate = new Date(streamRec.start_time);
        const endDate = new Date(streamRec.end_time);
        const rawDurationMs = endDate.getTime() - startDate.getTime();
        const durationInMinutes = Number.isFinite(rawDurationMs)
          ? Math.max(0, Math.round(rawDurationMs / (1000 * 60)))
          : 0;

        // Generate title from appointment info (same logic as handleRecordingReady)
        const title = generateRecordingTitle(appointment, startDate);
        const streamUrlExpiresAt = streamCopyExpiresAt(endDate);

        const recording = await prisma.recording.create({
          data: {
            title,
            recordingUrl: streamRec.url,
            durationInMinutes,
            recordedAt: startDate,
            streamRecordingId: streamRec.filename,
            streamCallId: session.streamCallId,
            storageType: "STREAM_S3",
            status: "READY",
            streamUrlExpiresAt,
            meetingId: session.id,
            organizationId: appointment?.organizationId ?? null,
          },
        });

        syncedRecordings.push(recording);

        streamLogger.info("Recording synced successfully", {
          recordingId: recording.id,
          sessionId: session.id,
          title,
          durationInMinutes,
        });
      }
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
