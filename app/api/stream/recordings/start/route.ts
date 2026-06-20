/**
 * Start Recording API Route
 * POST /api/stream/recordings/start
 *
 * Starts recording for a video call. Only consultants can start recordings.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import { getMeetingSessionOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";

import { getSession } from "@/lib/auth-server";
const startRecordingSchema = z.object({
  meetingSessionId: z.string().min(1, "Meeting session ID is required"),
});

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
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
    const { meetingSessionId } = startRecordingSchema.parse(body);

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

    // Look up consultant profile for the logged-in user
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    // Verify the consultant owns this appointment using helper function
    const { isOwner, recordingEnabled } = getMeetingSessionOwnershipInfo(
      meetingSession,
      consultantProfile?.id,
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

    // Atomically set isRecording=true (prevents race condition with concurrent requests)
    const updated = await prisma.meetingSession.updateMany({
      where: { id: meetingSessionId, isRecording: false },
      data: {
        isRecording: true,
        recordingStartedAt: new Date(),
        recordingStartedBy: session.user.id,
      },
    });

    if (updated.count === 0) {
      return NextResponse.json(
        { error: "Recording is already in progress" },
        { status: 409 },
      );
    }

    // Start recording via Stream API (use DB-stored call ID, never trust client)
    const result = await RecordingService.startRecording(
      meetingSession.streamCallId,
      session.user.id,
    );

    if (!result.success) {
      // Revert the DB state since Stream API failed
      await prisma.meetingSession.update({
        where: { id: meetingSessionId },
        data: { isRecording: false, recordingStartedAt: null, recordingStartedBy: null },
      });
      return NextResponse.json(
        { error: result.error || "Failed to start recording" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Recording started",
    });
  } catch (error) {
    streamLogger.error("Error starting recording", error);

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
