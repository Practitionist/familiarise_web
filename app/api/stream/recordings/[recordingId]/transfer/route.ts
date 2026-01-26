/**
 * Recording Transfer API Route
 * POST /api/stream/recordings/[recordingId]/transfer
 *
 * Manually triggers transfer of a recording from Stream S3 to Supabase.
 * Only consultants who own the recording can trigger transfer.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { getRecordingOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";

type RouteParams = {
  params: Promise<{
    recordingId: string;
  }>;
};

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only consultants can trigger transfers
    if (session.user.role !== "CONSULTANT") {
      return NextResponse.json(
        { error: "Only consultants can transfer recordings" },
        { status: 403 },
      );
    }

    const { recordingId } = await params;

    // Get recording with ownership info
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
        },
      },
    });

    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    // Verify ownership using helper function
    const { isOwner } = getRecordingOwnershipInfo(
      recording,
      session.user.consultantProfileId,
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to transfer this recording" },
        { status: 403 },
      );
    }

    // Check if recording is already transferred
    if (recording.storageType === "SUPABASE") {
      return NextResponse.json(
        { error: "Recording is already transferred to permanent storage" },
        { status: 400 },
      );
    }

    // Check if recording is in a transferable state
    if (recording.status !== "READY") {
      return NextResponse.json(
        {
          error: `Recording cannot be transferred in ${recording.status} state`,
        },
        { status: 400 },
      );
    }

    // Start transfer
    const result =
      await RecordingTransferService.transferRecordingToSupabase(recordingId);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Transfer failed" },
        { status: 500 },
      );
    }

    // Get updated recording
    const updatedRecording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        status: true,
        storageType: true,
        supabaseUrl: true,
        transferredAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Recording transferred successfully",
      recording: updatedRecording,
    });
  } catch (error) {
    console.error("Error transferring recording:", error);
    return NextResponse.json(
      { error: "Failed to transfer recording" },
      { status: 500 },
    );
  }
}
