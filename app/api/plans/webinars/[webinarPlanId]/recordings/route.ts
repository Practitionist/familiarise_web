/**
 * Webinar Plan Recordings API Route
 * GET /api/plans/webinars/[webinarPlanId]/recordings
 *
 * Gets all recordings for a specific webinar plan.
 * Access: Consultant owner or enrolled consultees.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import prisma from "@/lib/prisma";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  webinarRecordingVisible,
  type WebinarRecordingScope,
} from "@/lib/stream/recording-attendee-scope";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    webinarPlanId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession(true);
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
    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
    let hasAccess = false;

    if (isPrivileged(session.user.role)) {
      hasAccess = true;
    }

    // Provider path: owns the plan, or is an accepted collaborator.
    if (!hasAccess && session.user.consultantProfileId) {
      hasAccess =
        webinarPlan.consultantProfileId === session.user.consultantProfileId;
      if (!hasAccess) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            webinarPlanId,
            consultantProfileId: session.user.consultantProfileId,
            status: "ACCEPTED",
          },
        });
        hasAccess = !!collab;
      }
    }

    // Attendee path: must have purchased a webinar from this plan, and sees
    // only the runs the plan's sharing setting allows.
    let attendeeScope: WebinarRecordingScope | null = null;
    if (!hasAccess) {
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
      if (hasAccess) {
        ({ webinarScope: attendeeScope } =
          await RecordingService.getPaidPlanIds(session.user.id));
      }
    }

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to these recordings" },
        { status: 403 },
      );
    }

    const planRecordings =
      await RecordingService.getWebinarPlanRecordings(webinarPlanId);
    const scope = attendeeScope;
    const recordings = scope
      ? planRecordings.filter((recording) =>
          webinarRecordingVisible(
            {
              appointmentId: recording.meeting.occurrence.appointment.id,
              webinarPlanId,
            },
            scope,
          ),
        )
      : planRecordings;

    const formattedRecordings = recordings.map((recording) => ({
      id: recording.id,
      title: recording.title,
      durationInMinutes: recording.durationInMinutes,
      recordedAt: recording.recordedAt,
      status: recording.status,
      storageType: recording.storageType,
      // Playback URLs are minted per play by GET /api/stream/recordings/[id], which re-checks access.
      playbackUrl: null,
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "plans" } },
    );
    console.error("Error getting webinar plan recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
