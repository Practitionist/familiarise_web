import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/live
 * Transitions a backstage-enabled webinar or class room to live when invoked by an authorized host.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "admit to");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    if (access.role !== "host") {
      streamLogger.warn("Meeting go-live refused — caller is not the host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        {
          error: "Only the host can start the live session.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    const resolvedCallId = toCallId(access.streamCallId);
    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, resolvedCallId)
        .goLive(),
    );

    streamLogger.info("Meeting transitioned to live by host", {
      userId,
      meetingId: resolvedCallId,
    });

    return NextResponse.json({ live: true, callId: resolvedCallId });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting go-live unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, { subsystem: "stream", op: "meetings.live" });
    streamLogger.error("Failed to transition meeting to live", error);
    return NextResponse.json(
      { error: "Could not start the live session. Please try again." },
      { status: 500 },
    );
  }
}
