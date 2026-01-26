/**
 * Start Recording API Route
 * POST /api/stream/recordings/start
 *
 * Starts recording for a video call. Only consultants can start recordings.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingService } from "@/lib/stream/recording-service";
import { getMeetingSessionOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";

const startRecordingSchema = z.object({
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

    // Only consultants can start recordings
    if (session.user.role !== "CONSULTANT") {
      return NextResponse.json(
        { error: "Only consultants can start recordings" },
        { status: 403 },
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const { streamCallId, meetingSessionId } = startRecordingSchema.parse(body);

    // Verify the meeting session exists and belongs to consultant's appointment
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
                        recordingEnabled: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        consultantProfileId: true,
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
        { status: 404 },
      );
    }

    // Verify the consultant owns this appointment using helper function
    const { isOwner, recordingEnabled } = getMeetingSessionOwnershipInfo(
      meetingSession,
      session.user.consultantProfileId,
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to record this session" },
        { status: 403 },
      );
    }

    // Check if recording is enabled for this plan
    if (!recordingEnabled) {
      return NextResponse.json(
        { error: "Recording is not enabled for this plan" },
        { status: 400 },
      );
    }

    // Check if already recording
    if (meetingSession.isRecording) {
      return NextResponse.json(
        { error: "Recording is already in progress" },
        { status: 400 },
      );
    }

    // Start recording via Stream API
    const result = await RecordingService.startRecording(
      streamCallId,
      session.user.id,
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to start recording" },
        { status: 500 },
      );
    }

    // Update meeting session (webhook will also update, but we update immediately for UI)
    await prisma.meetingSession.update({
      where: { id: meetingSessionId },
      data: {
        isRecording: true,
        recordingStartedAt: new Date(),
        recordingStartedBy: session.user.id,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Recording started",
    });
  } catch (error) {
    console.error("Error starting recording:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: error.errors },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Failed to start recording" },
      { status: 500 },
    );
  }
}
