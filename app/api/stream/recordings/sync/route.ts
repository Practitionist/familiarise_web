/**
 * Sync Recordings API Route
 * POST /api/stream/recordings/sync
 *
 * Syncs recordings from Stream API for a user's sessions.
 * Creates Recording records for any recordings not already in DB.
 * Consultants sync their own sessions, consultees sync their enrolled sessions.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
export async function POST(_req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let result: {
      synced: number;
      recordings: {
        id: string;
        title: string;
        durationInMinutes: number;
        recordedAt: Date;
        status: string;
      }[];
    };

    if (session.user.role === "CONSULTANT") {
      // Consultant syncs their own sessions
      const consultantProfile = await prisma.consultantProfile.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      });
      const consultantProfileId = consultantProfile?.id;
      if (!consultantProfileId) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 },
        );
      }

      result =
        await RecordingService.syncRecordingsForConsultant(consultantProfileId);
    } else if (session.user.role === "CONSULTEE") {
      // Consultee syncs their enrolled sessions
      const consulteeProfile = await prisma.consulteeProfile.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      });
      const consulteeProfileId = consulteeProfile?.id;
      if (!consulteeProfileId) {
        return NextResponse.json(
          { error: "Consultee profile not found" },
          { status: 400 },
        );
      }

      result = await RecordingService.syncRecordingsForConsultee(
        consulteeProfileId,
        session.user.id,
      );
    } else {
      return NextResponse.json({ error: "Invalid user role" }, { status: 403 });
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });

    return NextResponse.json(
      { error: "Failed to sync recordings" },
      { status: 500 },
    );
  }
}
