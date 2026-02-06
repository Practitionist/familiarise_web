/**
 * Webinar Plan Recordings API Route
 * GET /api/plans/webinars/[webinarPlanId]/recordings
 *
 * Gets all recordings for a specific webinar plan.
 * Access: Consultant owner or enrolled consultees.
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    webinarPlanId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { webinarPlanId } = await params;

    // Get the webinar plan to check ownership and recording settings
    const webinarPlan = await prisma.webinarPlan.findUnique({
      where: { id: webinarPlanId },
      select: {
        id: true,
        title: true,
        consultantProfileId: true,
        recordingEnabled: true,
      },
    });

    if (!webinarPlan) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }

    // Check access permissions
    let hasAccess = false;

    if (session.user.role === "CONSULTANT") {
      // Consultant must own the plan
      hasAccess =
        webinarPlan.consultantProfileId === session.user.consultantProfileId;
    } else if (session.user.role === "CONSULTEE") {
      // Consultee must have purchased a webinar from this plan
      const enrollment = await prisma.payment.findFirst({
        where: {
          userId: session.user.id,
          paymentStatus: "SUCCEEDED",
          appointment: {
            webinar: {
              webinarPlanId,
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

    // Get recordings for this webinar plan
    const recordings =
      await RecordingService.getWebinarPlanRecordings(webinarPlanId);

    // Map recordings to response format
    const formattedRecordings = recordings.map((recording) => ({
      id: recording.id,
      title: recording.title,
      durationInMinutes: recording.durationInMinutes,
      recordedAt: recording.recordedAt,
      status: recording.status,
      storageType: recording.storageType,
      playbackUrl: RecordingTransferService.getBestRecordingUrl(recording),
      thumbnailUrl: recording.thumbnailUrl,
      resolution: recording.resolution,
      previewClipUrl: recording.previewClipUrl,
      previewClipDuration: recording.previewClipDuration,
      streamUrlExpiresAt: recording.streamUrlExpiresAt,
      createdAt: recording.createdAt,
    }));

    return NextResponse.json({
      planId: webinarPlanId,
      planTitle: webinarPlan.title,
      recordingEnabled: webinarPlan.recordingEnabled,
      recordings: formattedRecordings,
      total: formattedRecordings.length,
    });
  } catch (error) {
    console.error("Error getting webinar plan recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
