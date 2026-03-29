/**
 * Stop Recording API Route
 * POST /api/stream/recordings/stop
 *
 * Stops recording for a video call. Only consultants can stop recordings.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import { getMeetingSessionOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";

import { getSession } from "@/lib/auth-server";
const stopRecordingSchema = z.object({
  streamCallId: z.string().min(1, "Stream call ID is required"),
  meetingSessionId: z.string().min(1, "Meeting session ID is required"),
});

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only consultants can stop recordings
    if (session.user.role !== "CONSULTANT") {
      return NextResponse.json(
        { error: "Only consultants can stop recordings" },
        { status: 403 },
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
        { status: 404 },
      );
    }

    // Look up consultant profile for the logged-in user
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    // Verify the consultant owns this appointment using helper function
    const { isOwner } = getMeetingSessionOwnershipInfo(
      meetingSession,
      consultantProfile?.id,
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to stop this recording" },
        { status: 403 },
      );
    }

    // Verify recording is actually in progress before calling Stream API
    if (!meetingSession.isRecording) {
      return NextResponse.json(
        { error: "No recording in progress" },
        { status: 409 },
      );
    }

    // Atomically claim the stop operation (prevents concurrent stop requests)
    const claimed = await prisma.meetingSession.updateMany({
      where: { id: meetingSessionId, isRecording: true },
      data: { isRecording: false },
    });

    if (claimed.count === 0) {
      // Another concurrent request already claimed the stop
      return NextResponse.json(
        { error: "No recording in progress" },
        { status: 409 },
      );
    }

    // Stop recording via Stream API
    const result = await RecordingService.stopRecording(streamCallId);

    if (!result.success) {
      // Rollback: restore isRecording=true since Stream stop failed
      await prisma.meetingSession.update({
        where: { id: meetingSessionId },
        data: { isRecording: true },
      });
      streamLogger.error("Stream stop failed, rolled back DB state", null, {
        meetingSessionId,
        streamCallId,
      });
      return NextResponse.json(
        { error: result.error || "Failed to stop recording" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Recording stopped",
    });
  } catch (error) {
    streamLogger.error("Error stopping recording", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: error.errors },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Failed to stop recording" },
      { status: 500 },
    );
  }
}
