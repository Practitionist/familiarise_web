/**
 * Stream Recording Service
 * Provides methods to manage video call recordings
 */

import { getStreamVideoClient } from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { Recording, RecordingStatus, MeetingSession } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";

// Types for Stream Recording API responses
export interface StreamRecording {
  filename: string;
  url: string;
  start_time: Date;
  end_time: Date;
}

export interface RecordingWithSession extends Recording {
  meetingSession: MeetingSession & {
    slotOfAppointment: {
      appointment: {
        appointmentType: string;
        webinar?: {
          webinarPlan: {
            title: string;
            consultantProfileId: string | null;
          };
        } | null;
        class?: {
          classPlan: {
            title: string;
            consultantProfileId: string | null;
          };
        } | null;
      } | null;
    };
  };
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
    userId: string
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
    streamCallId: string
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
    streamCallId: string
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
    meetingSessionId: string
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
    webinarPlanId: string
  ): Promise<Recording[]> {
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
        include: {
          meetingSession: {
            include: {
              slotOfAppointment: {
                include: {
                  appointment: {
                    include: {
                      webinar: {
                        include: {
                          webinarPlan: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
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
    classPlanId: string
  ): Promise<Recording[]> {
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
        include: {
          meetingSession: {
            include: {
              slotOfAppointment: {
                include: {
                  appointment: {
                    include: {
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
   */
  static async getConsultantRecordings(
    consultantProfileId: string
  ): Promise<Recording[]> {
    try {
      const recordings = await prisma.recording.findMany({
        where: {
          OR: [
            {
              meetingSession: {
                slotOfAppointment: {
                  appointment: {
                    webinar: {
                      webinarPlan: {
                        consultantProfileId,
                      },
                    },
                  },
                },
              },
            },
            {
              meetingSession: {
                slotOfAppointment: {
                  appointment: {
                    class: {
                      classPlan: {
                        consultantProfileId,
                      },
                    },
                  },
                },
              },
            },
          ],
          status: {
            notIn: ["FAILED", "EXPIRED"],
          },
        },
        include: {
          meetingSession: {
            include: {
              slotOfAppointment: {
                include: {
                  appointment: {
                    include: {
                      webinar: {
                        include: {
                          webinarPlan: {
                            select: {
                              id: true,
                              title: true,
                            },
                          },
                        },
                      },
                      class: {
                        include: {
                          classPlan: {
                            select: {
                              id: true,
                              title: true,
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
        orderBy: {
          recordedAt: "desc",
        },
      });

      return recordings;
    } catch (error) {
      streamLogger.error("Failed to get consultant recordings", error, {
        consultantProfileId,
      });
      return [];
    }
  }

  /**
   * Get a single recording by ID
   * @param recordingId The recording ID
   */
  static async getRecordingById(
    recordingId: string
  ): Promise<Recording | null> {
    try {
      const recording = await prisma.recording.findUnique({
        where: { id: recordingId },
        include: {
          meetingSession: {
            include: {
              slotOfAppointment: {
                include: {
                  appointment: {
                    include: {
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
    additionalData?: Partial<Recording>
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
    appointmentId: string
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
    daysBeforeExpiry: number = 3
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
  static async getRecordingState(
    meetingSessionId: string
  ): Promise<{ isRecording: boolean; startedAt: Date | null; startedBy: string | null }> {
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
}

export default RecordingService;
