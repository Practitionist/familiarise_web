/**
 * Stop Recording API Route
 * POST /api/recordings/stop
 *
 * Stops recording for a video call. Only consultants can stop recordings.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingService } from "@/lib/stream/recording-service";
import prisma from "@/lib/prisma";

const stopRecordingSchema = z.object({
  streamCallId: z.string().min(1, "Stream call ID is required"),
  meetingSessionId: z.string().min(1, "Meeting session ID is required"),
});

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only consultants can stop recordings
    if (session.user.role !== "CONSULTANT") {
      return NextResponse.json(
        { error: "Only consultants can stop recordings" },
        { status: 403 }
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const { streamCallId, meetingSessionId } = stopRecordingSchema.parse(body);

    // Verify the meeting session exists
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { id: meetingSessionId },
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
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

    if (!meetingSession) {
      return NextResponse.json(
        { error: "Meeting session not found" },
        { status: 404 }
      );
    }

    // Verify the consultant owns this appointment
    const appointment = meetingSession.slotOfAppointment.appointment;
    let isOwner = false;

    if (appointment?.webinar?.webinarPlan) {
      isOwner =
        appointment.webinar.webinarPlan.consultantProfileId ===
        session.user.consultantProfileId;
    } else if (appointment?.class?.classPlan) {
      isOwner =
        appointment.class.classPlan.consultantProfileId ===
        session.user.consultantProfileId;
    }

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to stop this recording" },
        { status: 403 }
      );
    }

    // Check if recording is active
    if (!meetingSession.isRecording) {
      return NextResponse.json(
        { error: "No recording in progress" },
        { status: 400 }
      );
    }

    // Stop recording via Stream API
    const result = await RecordingService.stopRecording(streamCallId);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to stop recording" },
        { status: 500 }
      );
    }

    // Update meeting session (webhook will also update, but we update immediately for UI)
    await prisma.meetingSession.update({
      where: { id: meetingSessionId },
      data: {
        isRecording: false,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Recording stopped",
    });
  } catch (error) {
    console.error("Error stopping recording:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: error.errors },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Failed to stop recording" },
      { status: 500 }
    );
  }
}
