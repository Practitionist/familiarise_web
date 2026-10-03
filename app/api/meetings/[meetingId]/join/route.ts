import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/join
 * Verifies meeting access and DPDP consent, upserts the caller on Stream, and grants `call_member` membership.
 * Attendance and presence intervals are recorded exclusively by `call.session_participant_joined`/`left` webhooks.
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

    const role = "call_member";
    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);

    await withStreamCircuitBreaker(async () => {
      await upsertUsersToStream([userId]);

      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        resolvedCallId,
      );

      await call.getOrCreate({ data: { created_by_id: userId } });

      await call.updateCallMembers({
        update_members: [{ user_id: userId, role }],
      });
    });

    streamLogger.info("Admitted to meeting", {
      userId,
      meetingId: resolvedCallId,
      role: access.role,
    });

    return NextResponse.json({
      callType: STREAM_CALL_TYPE,
      callId: resolvedCallId,
      role: access.role,
    });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting join unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, {
      subsystem: "stream",
      op: "meetings.join",
    });
    streamLogger.error("Failed to admit to meeting", error);
    return NextResponse.json(
      { error: "Could not join this meeting. Please try again." },
      { status: 500 },
    );
  }
}
