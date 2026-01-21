/**
 * Sync Recordings API Route
 * POST /api/recordings/sync
 *
 * Syncs recordings from Stream API for a user's sessions.
 * Creates Recording records for any recordings not already in DB.
 * Consultants sync their own sessions, consultees sync their enrolled sessions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RecordingService } from "@/lib/stream/recording-service";

export async function POST(_req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let result: { synced: number; recordings: { id: string; title: string; durationInMinutes: number; recordedAt: Date; status: string }[] };

    if (session.user.role === "CONSULTANT") {
      // Consultant syncs their own sessions
      const consultantProfileId = session.user.consultantProfileId;
      if (!consultantProfileId) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 }
        );
      }

      result = await RecordingService.syncRecordingsForConsultant(
        consultantProfileId
      );
    } else if (session.user.role === "CONSULTEE") {
      // Consultee syncs their enrolled sessions
      const consulteeProfileId = session.user.consulteeProfileId;
      if (!consulteeProfileId) {
        return NextResponse.json(
          { error: "Consultee profile not found" },
          { status: 400 }
        );
      }

      result = await RecordingService.syncRecordingsForConsultee(
        consulteeProfileId,
        session.user.id
      );
    } else {
      return NextResponse.json(
        { error: "Invalid user role" },
        { status: 403 }
      );
    }

    return NextResponse.json({
      success: true,
      synced: result.synced,
      recordings: result.recordings.map((r) => ({
        id: r.id,
        title: r.title,
        durationInMinutes: r.durationInMinutes,
        recordedAt: r.recordedAt,
        status: r.status,
      })),
    });
  } catch (error) {
    console.error("Error syncing recordings:", error);

    return NextResponse.json(
      { error: "Failed to sync recordings" },
      { status: 500 }
    );
  }
}
