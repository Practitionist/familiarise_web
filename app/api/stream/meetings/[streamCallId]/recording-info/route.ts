/**
 * Meeting Recording Info API Route
 * GET /api/stream/meetings/[streamCallId]/recording-info
 *
 * Gets recording information for a meeting session.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

type RouteParams = {
  params: Promise<{
    streamCallId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { streamCallId } = await params;

    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        recordingEnabled: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        recordingEnabled: true,
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

    if (!meetingSession) {
      return NextResponse.json(
        { error: "Meeting session not found" },
        { status: 404 },
      );
    }

    const appointment = meetingSession.slotOfAppointment?.appointment;

    // Authorization check - verify user has access to this meeting
    const consultantProfileId =
      appointment?.webinar?.webinarPlan?.consultantProfileId ||
      appointment?.class?.classPlan?.consultantProfileId;

    // Admin/Staff can access any meeting
    if (session.user.role !== "ADMIN" && session.user.role !== "STAFF") {
      // Consultant can access their own meetings
      if (session.user.role === "CONSULTANT") {
        if (session.user.consultantProfileId !== consultantProfileId) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }
      } else {
        // Consultee needs enrollment verification
        // Check if user has paid enrollment for this webinar/class
        const webinarId = appointment?.webinar?.id;
        const classId = appointment?.class?.id;

        if (!webinarId && !classId) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }

        const enrollmentConditions = [];
        if (webinarId) {
          enrollmentConditions.push({ webinarId });
        }
        if (classId) {
          enrollmentConditions.push({ classId });
        }

        const hasEnrollment = await prisma.payment.findFirst({
          where: {
            userId: session.user.id,
            paymentStatus: "SUCCEEDED",
            appointment: {
              OR: enrollmentConditions,
            },
          },
        });

        if (!hasEnrollment) {
          return NextResponse.json({ error: "Access denied" }, { status: 403 });
        }
      }
    }

    // Determine if recording is enabled based on appointment type
    let recordingEnabled = false;

    if (appointment?.webinar?.webinarPlan) {
      recordingEnabled = appointment.webinar.webinarPlan.recordingEnabled;
    } else if (appointment?.class?.classPlan) {
      recordingEnabled = appointment.class.classPlan.recordingEnabled;
    }

    return NextResponse.json({
      meetingSessionId: meetingSession.id,
      recordingEnabled,
      isRecording: meetingSession.isRecording,
      recordingStartedAt: meetingSession.recordingStartedAt,
      recordingStartedBy: meetingSession.recordingStartedBy,
    });
  } catch (error) {
    console.error("Error getting meeting recording info:", error);
    return NextResponse.json(
      { error: "Failed to get recording info" },
      { status: 500 },
    );
  }
}
