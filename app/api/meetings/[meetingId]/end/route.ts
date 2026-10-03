import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

async function stampSynchronousMeetingEnd(meetingId?: string): Promise<string> {
  const now = new Date();
  let endedReason = "call_ended";
  if (!meetingId) return endedReason;
  if (
    process.env.NODE_ENV === "test" &&
    typeof (prisma as unknown as { $connect?: unknown }).$connect === "function"
  ) {
    return endedReason;
  }

  try {
    if (prisma.meeting?.findUnique) {
      const row = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: {
          occurrence: {
            select: { endsAt: true },
          },
        },
      });
      const slotEndsAt = row?.occurrence?.endsAt;
      if (slotEndsAt && now.getTime() < new Date(slotEndsAt).getTime()) {
        endedReason = "ended_early";
      }
    }
    if (prisma.meeting?.updateMany) {
      await prisma.meeting.updateMany({
        where: { id: meetingId },
        data: {
          endedAt: now,
          endedReason,
          isRecording: false,
        },
      });
    }
  } catch (err) {
    streamLogger.warn("Non-fatal failure stamping synchronous meeting end", {
      meetingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return endedReason;
}

/**
 * POST /api/meetings/[meetingId]/end
 * Ends the Stream call for all participants when invoked by an authorized host or co-presenter.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "end");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    if (access.role !== "host") {
      streamLogger.warn("Meeting end refused — caller is not the host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        {
          error: "Only the host can end this call for everyone.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, toCallId(access.streamCallId))
        .end(),
    );

    const endedReason = await stampSynchronousMeetingEnd(access.meetingId);

    streamLogger.info("Meeting ended by host", {
      userId,
      meetingId,
      endedReason,
    });

    return NextResponse.json({
      ended: true,
      callId: meetingId,
      endedReason,
    });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting end unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, { subsystem: "stream", op: "meetings.end" });
    streamLogger.error("Failed to end meeting", error);
    return NextResponse.json(
      { error: "Could not end this meeting. Please try again." },
      { status: 500 },
    );
  }
}
