/**
 * Consultee Recordings API Route
 * GET /api/consultees/[consulteeId]/recordings
 *
 * Gets all recordings the consultee has access to through their enrollments.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingService } from "@/lib/stream/recording-service";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";

type RouteParams = {
  params: Promise<{
    consulteeId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consulteeId } = await params;

    // Verify the user is accessing their own recordings (or admin/staff)
    if (
      session.user.role !== "ADMIN" &&
      session.user.role !== "STAFF" &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Parse query params for filtering
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") as "webinar" | "class" | null;

    // Get recordings from service
    const recordings = await RecordingService.getConsulteeRecordings(
      session.user.id,
      { type: type || undefined },
    );

    // Format recordings for response
    const formattedRecordings = recordings.map((recording) => {
      const appointment =
        recording.meetingSession?.slotOfAppointment?.appointment;

      let planType: "webinar" | "class" | null = null;
      let planId: string | null = null;
      let planTitle: string | null = null;

      if (appointment?.webinar?.webinarPlan) {
        planType = "webinar";
        planId = appointment.webinar.webinarPlan.id ?? null;
        planTitle = appointment.webinar.webinarPlan.title ?? null;
      } else if (appointment?.class?.classPlan) {
        planType = "class";
        planId = appointment.class.classPlan.id ?? null;
        planTitle = appointment.class.classPlan.title ?? null;
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
    console.error("Error getting consultee recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
