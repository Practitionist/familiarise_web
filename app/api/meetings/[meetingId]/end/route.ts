import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { recordMeetingEndedSynchronously } from "@/lib/stream/session-handlers";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/end
 * Ends the Stream call for all participants when invoked by an authorized host or co-presenter,
 * stamping `Meeting.endedAt` synchronously via CAS so immediate dashboard reloads reflect termination.
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

    const resolvedCallId = toCallId(access.streamCallId);
    await withStreamCircuitBreaker(() =>
      getStreamVideoClient().video.call(STREAM_CALL_TYPE, resolvedCallId).end(),
    );

    const recorded = await recordMeetingEndedSynchronously(
      resolvedCallId,
      new Date(),
    ).catch((err) => {
      streamLogger.warn(
        "Synchronous end stamp failed; webhook will reconcile",
        {
          meetingId,
          reason: err instanceof Error ? err.message : String(err),
        },
      );
      return null;
    });

    streamLogger.info("Meeting ended by host", {
      userId,
      meetingId,
      endedReason: recorded?.endedReason ?? null,
    });

    return NextResponse.json({ ended: true, callId: meetingId });
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
