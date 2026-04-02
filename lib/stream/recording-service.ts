/**
 * Stream Recording Service
 * Provides methods to manage video call recordings
 */

import { getStreamVideoClient } from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { Prisma, Recording, RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { generateRecordingTitle } from "@/lib/stream/recording-utils";
import type {
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

// Types for Stream Recording API responses
export interface StreamRecording {
  filename: string;
  url: string;
  start_time: Date;
  end_time: Date;
}

/**
 * Recording Service class for managing video call recordings
 */
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

      // Get call type from call ID (format: "callType:callId" or just "callId")
      const callType = "default";
      const callId = streamCallId.includes(":")
        ? streamCallId.split(":")[1]
        : streamCallId;

      // Get the call and start recording
      const call = client.video.call(callType, callId);
      await call.startRecording();

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
   */
  static async stopRecording(
    streamCallId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = getStreamVideoClient();

      const callType = "default";
      const callId = streamCallId.includes(":")
        ? streamCallId.split(":")[1]
        : streamCallId;

      const call = client.video.call(callType, callId);
      await call.stopRecording();

      streamLogger.info("Recording stopped via API", {
        streamCallId: callId,
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to stop recording";
      streamLogger.error("Failed to stop recording", error, {
        streamCallId,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get recordings for a specific call from Stream
   * @param streamCallId The Stream call ID
   */
  static async getCallRecordingsFromStream(
    streamCallId: string,
  ): Promise<StreamRecording[]> {
    try {
      const client = getStreamVideoClient();

      const callType = "default";
      const callId = streamCallId.includes(":")
        ? streamCallId.split(":")[1]
        : streamCallId;

      const call = client.video.call(callType, callId);
      const response = await call.listRecordings();

      return response.recordings.map((r) => ({
        filename: r.filename,
        url: r.url,
        start_time: r.start_time,
        end_time: r.end_time,
      }));
    } catch (error) {
      streamLogger.error("Failed to get call recordings from Stream", error, {
        streamCallId,
      });
      return [];
    }
  }

  /**
   * Get recordings for a meeting session from database
   * @param meetingSessionId The meeting session ID
   */
  static async getSessionRecordings(
    meetingSessionId: string,
  ): Promise<Recording[]> {
    try {
      const recordings = await prisma.recording.findMany({
        where: {
          meetingSessionId,
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
        meetingSessionId,
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
          meetingSession: {
            slotOfAppointment: {
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
          meetingSession: {
            slotOfAppointment: {
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
      type?: "webinar" | "class";
      status?: RecordingStatus;
      search?: string;
      page?: number;
      limit?: number;
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
          meetingSession: {
            slotOfAppointment: {
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
          meetingSession: {
            slotOfAppointment: {
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
          meetingSession: {
            slotOfAppointment: {
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
          meetingSession: {
            slotOfAppointment: {
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
   * Get paid webinar/class plan IDs for a user based on successful payments.
   * Shared by getConsulteeRecordings and the resources API.
   * @param userId The user ID
   */
  static async getPaidPlanIds(userId: string): Promise<{
    webinarPlanIds: string[];
    classPlanIds: string[];
  }> {
    const enrolledAppointments = await prisma.payment.findMany({
      where: {
        userId,
        paymentStatus: "SUCCEEDED",
        appointment: {
          OR: [{ webinar: { isNot: null } }, { class: { isNot: null } }],
        },
      },
      select: {
        appointment: {
          select: {
            webinar: { select: { webinarPlanId: true } },
            class: { select: { classPlanId: true } },
          },
        },
      },
    });

    const webinarPlanIds = Array.from(
      new Set(
        enrolledAppointments
          .map((e) => e.appointment?.webinar?.webinarPlanId)
          .filter((id): id is string => !!id),
      ),
    );
    const classPlanIds = Array.from(
      new Set(
        enrolledAppointments
          .map((e) => e.appointment?.class?.classPlanId)
          .filter((id): id is string => !!id),
      ),
    );

    return { webinarPlanIds, classPlanIds };
  }

  /**
   * Get all recordings for a consultee (paid enrollments only)
   * @param userId The user ID (for payment lookup)
   * @param filters Optional filters for type
   */
  static async getConsulteeRecordings(
    userId: string,
    filters?: {
      type?: "webinar" | "class";
    },
  ): Promise<ConsulteeRecordingWithDetails[]> {
    try {
      const { webinarPlanIds, classPlanIds } =
        await this.getPaidPlanIds(userId);

      // Build query based on type filter
      const whereConditions = [];

      if (!filters?.type || filters.type === "webinar") {
        if (webinarPlanIds.length > 0) {
          whereConditions.push({
            meetingSession: {
              slotOfAppointment: {
                appointment: {
                  webinar: {
                    webinarPlanId: {
                      in: webinarPlanIds,
                    },
                  },
                },
              },
            },
          });
        }
      }

      if (!filters?.type || filters.type === "class") {
        if (classPlanIds.length > 0) {
          whereConditions.push({
            meetingSession: {
              slotOfAppointment: {
                appointment: {
                  class: {
                    classPlanId: {
                      in: classPlanIds,
                    },
                  },
                },
              },
            },
          });
        }
      }

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
        },
        include: consulteeRecordingInclude,
        orderBy: {
          recordedAt: "desc",
        },
      });

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
        include: recordingWithAccessControlInclude,
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
    additionalData?: Partial<Recording>,
  ): Promise<Recording | null> {
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

      // Check webinar recording setting
      if (appointment.webinar?.webinarPlan?.recordingEnabled) {
        return true;
      }

      // Check class recording setting
      if (appointment.class?.classPlan?.recordingEnabled) {
        return true;
      }

      // Consultations and subscriptions don't have recording enabled by default
      return false;
    } catch (error) {
      streamLogger.error("Failed to check recording enabled", error, {
        appointmentId,
      });
      return false;
    }
  }

  /**
   * Get recordings that are expiring soon (for transfer to Supabase)
   * @param daysBeforeExpiry Number of days before expiry to consider
   */
  static async getExpiringRecordings(
    daysBeforeExpiry: number = 3,
  ): Promise<Recording[]> {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + daysBeforeExpiry);

    try {
      const recordings = await prisma.recording.findMany({
        where: {
          storageType: "STREAM_S3",
          status: "READY",
          streamUrlExpiresAt: {
            lte: expiryThreshold,
          },
        },
        orderBy: {
          streamUrlExpiresAt: "asc",
        },
      });

      return recordings;
    } catch (error) {
      streamLogger.error("Failed to get expiring recordings", error, {
        daysBeforeExpiry,
      });
      return [];
    }
  }

  /**
   * Get the current recording state for a meeting session
   * @param meetingSessionId The meeting session ID
   */
  static async getRecordingState(meetingSessionId: string): Promise<{
    isRecording: boolean;
    startedAt: Date | null;
    startedBy: string | null;
  }> {
    try {
      const session = await prisma.meetingSession.findUnique({
        where: { id: meetingSessionId },
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
        meetingSessionId,
      });
      return { isRecording: false, startedAt: null, startedBy: null };
    }
  }

  /**
   * Sync recordings from Stream API for a consultant's sessions
   * Creates Recording records for any recordings not already in DB
   * @param consultantProfileId The consultant profile ID
   */
  static async syncRecordingsForConsultant(
    consultantProfileId: string,
  ): Promise<{ synced: number; recordings: Recording[] }> {
    const syncedRecordings: Recording[] = [];

    try {
      // Define the include for meeting sessions with full appointment details
      const meetingSessionInclude = {
        slotOfAppointment: {
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

      // Get all MeetingSessions for consultant's webinars and classes (owned or collaborated)
      const meetingSessions = await prisma.meetingSession.findMany({
        where: {
          streamCallId: { not: "" },
          slotOfAppointment: {
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
              ],
            },
          },
        },
        include: meetingSessionInclude,
      });

      streamLogger.info("Syncing recordings for consultant", {
        consultantProfileId,
        sessionCount: meetingSessions.length,
      });

      // For each session, fetch recordings from Stream and sync
      for (const session of meetingSessions) {
        if (!session.streamCallId) continue;

        try {
          const streamRecordings = await this.getCallRecordingsFromStream(
            session.streamCallId,
          );

          for (const streamRec of streamRecordings) {
            // Check if recording already exists (by filename/streamRecordingId)
            const existingRecording = await prisma.recording.findFirst({
              where: {
                meetingSessionId: session.id,
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

            // Calculate duration in minutes
            const startDate = new Date(streamRec.start_time);
            const endDate = new Date(streamRec.end_time);
            const durationInMinutes = Math.round(
              (endDate.getTime() - startDate.getTime()) / (1000 * 60),
            );

            // Generate title from appointment info (same logic as handleRecordingReady)
            const appointment = session.slotOfAppointment.appointment;
            const title = generateRecordingTitle(appointment, startDate);

            // Calculate Stream URL expiration (2 weeks from now)
            const streamUrlExpiresAt = new Date();
            streamUrlExpiresAt.setDate(streamUrlExpiresAt.getDate() + 14);

            // Create recording record
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
                meetingSessionId: session.id,
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
        } catch (sessionError) {
          streamLogger.error(
            "Failed to sync recordings for session",
            sessionError,
            {
              sessionId: session.id,
              streamCallId: session.streamCallId,
            },
          );
          // Continue with next session even if one fails
        }
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
  ): Promise<{ synced: number; recordings: Recording[] }> {
    const syncedRecordings: Recording[] = [];

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

      // Find all paid enrollments for webinars/classes through Payment records
      const paidEnrollments = await prisma.payment.findMany({
        where: {
          userId: effectiveUserId,
          paymentStatus: "SUCCEEDED",
          appointment: {
            OR: [{ webinar: { isNot: null } }, { class: { isNot: null } }],
          },
        },
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  meetingSession: {
                    include: {
                      slotOfAppointment: {
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
      type MeetingSessionWithDetails = NonNullable<
        (typeof paidEnrollments)[0]["appointment"]
      >["slotsOfAppointment"][0]["meetingSession"];
      const meetingSessions: NonNullable<MeetingSessionWithDetails>[] = [];

      for (const payment of paidEnrollments) {
        if (!payment.appointment) continue;
        for (const slot of payment.appointment.slotsOfAppointment) {
          if (slot.meetingSession && slot.meetingSession.streamCallId) {
            meetingSessions.push(slot.meetingSession);
          }
        }
      }

      // Deduplicate sessions by ID
      const uniqueSessions = Array.from(
        new Map(meetingSessions.map((s) => [s.id, s])).values(),
      );

      streamLogger.info("Syncing recordings for consultee", {
        consulteeProfileId,
        sessionCount: uniqueSessions.length,
      });

      // For each session, fetch recordings from Stream and sync
      for (const session of uniqueSessions) {
        if (!session.streamCallId) continue;

        try {
          const streamRecordings = await this.getCallRecordingsFromStream(
            session.streamCallId,
          );

          for (const streamRec of streamRecordings) {
            // Check if recording already exists (by filename/streamRecordingId)
            const existingRecording = await prisma.recording.findFirst({
              where: {
                meetingSessionId: session.id,
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

            // Calculate duration in minutes
            const startDate = new Date(streamRec.start_time);
            const endDate = new Date(streamRec.end_time);
            const durationInMinutes = Math.round(
              (endDate.getTime() - startDate.getTime()) / (1000 * 60),
            );

            // Generate title from appointment info (same logic as handleRecordingReady)
            const appointment = session.slotOfAppointment.appointment;
            const title = generateRecordingTitle(appointment, startDate);

            // Calculate Stream URL expiration (2 weeks from now)
            const streamUrlExpiresAt = new Date();
            streamUrlExpiresAt.setDate(streamUrlExpiresAt.getDate() + 14);

            // Create recording record
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
                meetingSessionId: session.id,
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
        } catch (sessionError) {
          streamLogger.error(
            "Failed to sync recordings for session",
            sessionError,
            {
              sessionId: session.id,
              streamCallId: session.streamCallId,
            },
          );
          // Continue with next session even if one fails
        }
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

export default RecordingService;
