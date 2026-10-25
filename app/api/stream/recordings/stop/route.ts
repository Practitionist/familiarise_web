/**
 * Stop Recording API Route
 * POST /api/stream/recordings/stop
 *
 * Stops recording for a video call. Only consultants can stop recordings.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import { getMeetingOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";
import {
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";

import { getSession } from "@/lib/auth-server";
const stopRecordingSchema = z.object({
  meetingId: z.string().min(1, "Meeting session ID is required"),
});

export async function POST(req: NextRequest) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user) return fileApiError("UNAUTHORIZED");

    // Capability, not UserRole (#org-appts): anyone who OWNS a consultantProfile
    // (incl. an org EXPERT whose marketplace identity is CONSULTEE) may control
    // their own recordings — the per-appointment ownership check below is the
    // real authz. ADMIN/STAFF are handled by that check too.
    if (!session.user.consultantProfileId) return fileApiError("FORBIDDEN");

    const { meetingId } = await parseJsonBody(req, stopRecordingSchema);

    // Verify the meeting session exists
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        consultantProfileId: true,
                        // #1580 C-P1-4 — the accepted co-presenter may stop too.
                        collaborators: {
                          where: {
                            status: "ACCEPTED" as const,
                            consultantProfile: { deletedAt: null },
                          },
                          select: { consultantProfileId: true, role: true },
                        },
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        consultantProfileId: true,
                        // #1580 C-P1-4 — the accepted co-presenter may stop too.
                        collaborators: {
                          where: {
                            status: "ACCEPTED" as const,
                            consultantProfile: { deletedAt: null },
                          },
                          select: { consultantProfileId: true, role: true },
                        },
                      },
                    },
                  },
                },
                // #1134 P1-6 — mirror the start route: without these the owner
                // of a 1:1 cannot stop a recording they were able to start.
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                trial: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
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

    if (!meeting) return fileApiError("NOT_FOUND");

    // Look up consultant profile for the logged-in user
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    const normalizedMeeting =
      meeting.occurrence?.appointment?.trial &&
      !meeting.occurrence.appointment.subscription
        ? {
            ...meeting,
            occurrence: {
              ...meeting.occurrence,
              appointment: {
                ...meeting.occurrence.appointment,
                subscription: meeting.occurrence.appointment.trial,
              },
            },
          }
        : meeting;

    // Verify the consultant owns this appointment using helper function
    const { isOwner } = getMeetingOwnershipInfo(
      normalizedMeeting,
      consultantProfile?.id,
    );

    if (!isOwner) return fileApiError("FORBIDDEN");
    if (!meeting.isRecording) return fileApiError("RECORDING_NOT_IN_PROGRESS");

    // Atomically claim the stop of the segment this request read.
    const segment = {
      streamCallId: meeting.streamCallId,
      recordingStartedAt: meeting.recordingStartedAt,
    };
    const claimed = await prisma.meeting.updateMany({
      where: { id: meetingId, isRecording: true, ...segment },
      data: { isRecording: false },
    });

    // Another concurrent request already claimed the stop.
    if (claimed.count === 0) return fileApiError("RECORDING_NOT_IN_PROGRESS");

    // Stop recording via Stream API (use DB-stored call ID, never trust client)
    const result = await RecordingService.stopRecording(meeting.streamCallId);

    if (!result.success) {
      // Restore only the segment this request stopped, and never on an ended meeting.
      await prisma.meeting.updateMany({
        where: { id: meetingId, isRecording: false, endedAt: null, ...segment },
        data: { isRecording: true },
      });
      streamLogger.error("Stream stop failed, rolled back DB state", null, {
        meetingId,
        streamCallId: meeting.streamCallId,
        error: result.error,
      });
      return fileApiError("VENDOR_UNAVAILABLE");
    }

    return NextResponse.json({
      success: true,
      message: "Recording stopped",
    });
  }, "stream");
}
