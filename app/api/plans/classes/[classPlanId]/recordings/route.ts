/**
 * Class Plan Recordings API Route
 * GET /api/plans/classes/[classPlanId]/recordings
 *
 * Gets all recordings for a specific class plan.
 * Access: Consultant owner or enrolled consultees.
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    classPlanId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { classPlanId } = await params;

    // Get the class plan to check ownership and recording settings
    const classPlan = await prisma.classPlan.findUnique({
      where: { id: classPlanId },
      select: {
        id: true,
        title: true,
        consultantProfileId: true,
        recordingEnabled: true,
      },
    });

    if (!classPlan) {
      return NextResponse.json(
        { error: "Class plan not found" },
        { status: 404 },
      );
    }

    // Check access permissions
    let hasAccess = false;

    if (session.user.role === "CONSULTANT") {
      // Consultant must own the plan, or be an accepted collaborator
      hasAccess =
        classPlan.consultantProfileId === session.user.consultantProfileId;
      if (!hasAccess && session.user.consultantProfileId) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            classPlanId,
            consultantProfileId: session.user.consultantProfileId,
            status: "ACCEPTED",
          },
        });
        hasAccess = !!collab;
      }
    } else if (session.user.role === "CONSULTEE") {
      // Consultee must have purchased a class from this plan
      const enrollment = await prisma.payment.findFirst({
        where: {
          userId: session.user.id,
          paymentStatus: "SUCCEEDED",
          appointment: {
            class: {
              classPlanId,
            },
          },
        },
      });
      hasAccess = !!enrollment;
    } else if (session.user.role === "ADMIN" || session.user.role === "STAFF") {
      hasAccess = true;
    }

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to these recordings" },
        { status: 403 },
      );
    }

    // Get recordings for this class plan
    const recordings =
      await RecordingService.getClassPlanRecordings(classPlanId);

    // Map recordings to response format (async — presigned URLs)
    const formattedRecordings = await Promise.all(recordings.map(async (recording) => ({
      id: recording.id,
      title: recording.title,
      durationInMinutes: recording.durationInMinutes,
      recordedAt: recording.recordedAt,
      status: recording.status,
      storageType: recording.storageType,
      playbackUrl: await RecordingTransferService.getBestRecordingUrl(recording),
      thumbnailUrl: recording.thumbnailUrl,
      resolution: recording.resolution,
      previewClipUrl: recording.previewClipUrl,
      previewClipDuration: recording.previewClipDuration,
      streamUrlExpiresAt: recording.streamUrlExpiresAt,
      createdAt: recording.createdAt,
    })));

    return NextResponse.json({
      planId: classPlanId,
      planTitle: classPlan.title,
      recordingEnabled: classPlan.recordingEnabled,
      recordings: formattedRecordings,
      total: formattedRecordings.length,
    });
  } catch (error) {
    console.error("Error getting class plan recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
