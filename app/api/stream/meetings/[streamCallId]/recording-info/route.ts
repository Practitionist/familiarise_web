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
            },
          },
        },
      },
    });

    if (!meetingSession) {
      return NextResponse.json(
        { error: "Meeting session not found" },
        { status: 404 }
      );
    }

    // Determine if recording is enabled based on appointment type
    let recordingEnabled = false;

    const appointment = meetingSession.slotOfAppointment?.appointment;

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
      { status: 500 }
    );
  }
}
