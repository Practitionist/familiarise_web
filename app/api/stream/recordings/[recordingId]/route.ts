/**
 * Recording Details API Route
 * GET /api/stream/recordings/[recordingId]
 *
 * Gets details for a specific recording. Access control based on user role.
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    recordingId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { recordingId } = await params;

    // Get recording with related data
    const recording = await RecordingService.getRecordingById(recordingId);

    if (!recording) {
      return NextResponse.json(
        { error: "Recording not found" },
        { status: 404 },
      );
    }

    // Check access permissions
    const appointment = recording.meetingSession.slotOfAppointment.appointment;

    let hasAccess = false;

    if (session.user.role === "CONSULTANT") {
      // Consultant can access their own recordings, or recordings of plans they collaborate on
      const consultantProfileId = session.user.consultantProfileId;

      if (appointment?.webinar?.webinarPlan) {
        hasAccess =
          appointment.webinar.webinarPlan.consultantProfileId ===
          consultantProfileId;
        if (!hasAccess && consultantProfileId) {
          const collab = await prisma.webinarCollaborator.findFirst({
            where: {
              webinarPlanId: appointment.webinar.webinarPlan.id,
              consultantProfileId,
              status: "ACCEPTED",
            },
          });
          hasAccess = !!collab;
        }
      } else if (appointment?.class?.classPlan) {
        hasAccess =
          appointment.class.classPlan.consultantProfileId ===
          consultantProfileId;
        if (!hasAccess && consultantProfileId) {
          const collab = await prisma.classCollaborator.findFirst({
            where: {
              classPlanId: appointment.class.classPlan.id,
              consultantProfileId,
              status: "ACCEPTED",
            },
          });
          hasAccess = !!collab;
        }
      }
    } else if (session.user.role === "CONSULTEE") {
      // Consultee can access recordings for sessions they participated in
      // Check if user is enrolled in the webinar/class
      // Get the appointment ID from the recording chain to check payments
      const appointmentId =
        recording.meetingSession.slotOfAppointment.appointmentId;

      if (appointmentId && (appointment?.webinar || appointment?.class)) {
        // Check if user has paid for this appointment (webinar or class)
        const payment = await prisma.payment.findFirst({
          where: {
            userId: session.user.id,
            appointmentId,
            paymentStatus: "SUCCEEDED",
          },
        });
        hasAccess = !!payment;
      }
    } else if (session.user.role === "ADMIN" || session.user.role === "STAFF") {
      // Admin and staff can access all recordings
      hasAccess = true;
    }

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to this recording" },
        { status: 403 },
      );
    }

    // Get the best available URL
    const playbackUrl = RecordingTransferService.getBestRecordingUrl(recording);

    return NextResponse.json({
      recording: {
        id: recording.id,
        title: recording.title,
        durationInMinutes: recording.durationInMinutes,
        recordedAt: recording.recordedAt,
        status: recording.status,
        storageType: recording.storageType,
        playbackUrl,
        thumbnailUrl: recording.thumbnailUrl,
        resolution: recording.resolution,
        previewClipUrl: recording.previewClipUrl,
        previewClipDuration: recording.previewClipDuration,
        streamUrlExpiresAt: recording.streamUrlExpiresAt,
        createdAt: recording.createdAt,
      },
    });
  } catch (error) {
    console.error("Error getting recording:", error);
    return NextResponse.json(
      { error: "Failed to get recording" },
      { status: 500 },
    );
  }
}
