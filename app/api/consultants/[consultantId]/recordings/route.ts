/**
 * Consultant Recordings API Route
 * GET /api/consultants/[consultantId]/recordings
 *
 * Gets all recordings for a consultant's webinars and classes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingService } from "@/lib/stream/recording-service";
import { ConsultantRecordingWithDetails } from "@/lib/stream/recording-types";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";

type RouteParams = {
  params: Promise<{
    consultantId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultantId } = await params;

    // Verify the user is accessing their own recordings
    if (
      session.user.role !== "ADMIN" &&
      session.user.role !== "STAFF" &&
      session.user.consultantProfileId !== consultantId
    ) {
      return NextResponse.json(
        { error: "Access denied" },
        { status: 403 }
      );
    }

    // Parse query params for filtering
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type"); // "webinar" or "class"
    const status = searchParams.get("status"); // Recording status filter

    // Get all recordings for consultant
    const recordings = await RecordingService.getConsultantRecordings(consultantId);

    // Filter by type if specified
    let filteredRecordings: ConsultantRecordingWithDetails[] = recordings;
    if (type === "webinar") {
      filteredRecordings = recordings.filter(
        (r) => r.meetingSession.slotOfAppointment.appointment?.webinar
      );
    } else if (type === "class") {
      filteredRecordings = recordings.filter(
        (r) => r.meetingSession.slotOfAppointment.appointment?.class
      );
    }

    // Filter by status if specified
    if (status) {
      filteredRecordings = filteredRecordings.filter(
        (r) => r.status === status
      );
    }

    // Map recordings to response format with best URLs
    const formattedRecordings = filteredRecordings.map((recording) => {
      const appointment =
        recording.meetingSession.slotOfAppointment.appointment;

      let planType: "webinar" | "class" | null = null;
      let planId: string | null = null;
      let planTitle: string | null = null;

      if (appointment?.webinar?.webinarPlan) {
        planType = "webinar";
        planId = appointment.webinar.webinarPlan.id;
        planTitle = appointment.webinar.webinarPlan.title;
      } else if (appointment?.class?.classPlan) {
        planType = "class";
        planId = appointment.class.classPlan.id;
        planTitle = appointment.class.classPlan.title;
      }

      return {
        id: recording.id,
        title: recording.title,
        durationInMinutes: recording.durationInMinutes,
        recordedAt: recording.recordedAt,
        status: recording.status,
        storageType: recording.storageType,
        playbackUrl: RecordingTransferService.getBestRecordingUrl(recording),
        thumbnailUrl: recording.thumbnailUrl,
        resolution: recording.resolution,
        streamUrlExpiresAt: recording.streamUrlExpiresAt,
        transferredAt: recording.transferredAt,
        planType,
        planId,
        planTitle,
        createdAt: recording.createdAt,
      };
    });

    return NextResponse.json({
      recordings: formattedRecordings,
      total: formattedRecordings.length,
    });
  } catch (error) {
    console.error("Error getting consultant recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 }
    );
  }
}
