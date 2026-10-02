import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { normalizeCallType, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/end
 *
 * #1270 — ending a call for everyone, decided by the server.
 *
 * `end-call` is granted to `call_member` on the live `default` call type, and
 * the join route gives every participant that role. So the only thing stopping
 * a consultee from ending a consultation was `EndCallButton` not rendering for
 * them — a React conditional over `custom.consultantUserId`, which until this
 * change was a value the browser itself had written when it minted the call.
 * Two lines in devtools ended the session for everyone in the room.
 *
 * This route is the replacement affordance. It re-resolves access from the
 * database and requires the caller to be on the hosting side, so revoking
 * `end-call` from `call_member` in scripts/stream/ensure-call-type-grants.ts
 * becomes possible without taking the host's own control down with it. That
 * revocation has since been applied on the live type (#1607): `call_member`
 * keeps `join-ended-call` and nothing else that ends or records.
 *
 * "Host" is `resolveMeetingAccess`'s host — the plan owner OR an accepted
 * collaborator on a webinar or class. Collaborators co-deliver those sessions,
 * so an owner-only test would leave a co-host unable to close a room they are
 * running. It is wider than the button's own `isHost`, which compares against a
 * single `custom.consultantUserId`; a collaborator sees no button and would
 * have to call this deliberately.
 *
 * `Meeting.endedAt` is deliberately not written here. The `call.ended`
 * webhook owns it, and it also sets the slot's completionStatus and the
 * session's actual duration — writing `endedAt` first would make that handler
 * treat the event as a duplicate and skip all of it.
 *
 * ## The call type is read off the row, not assumed
 *
 * There are two call types now (#1134 P1-5). This route used to address
 * `STREAM_CALL_TYPE` unconditionally, which is a 404 for a webinar or class
 * once those are minted on `livestream` — and a 404 here is a silent failure
 * of exactly the kind this subsystem is full of: the room stays open, the host
 * sees an error, and nothing pages because the route reported the fault
 * honestly.
 *
 * The type comes from `Meeting.callType`, read by `access.meetingId` (the ROW,
 * not the URL segment — #C8/#C9) and passed through `normalizeCallType`, which
 * is what keeps a hand-edited column from addressing a call type this app does
 * not mint on (#1285). It is NOT read out of the cid: `Meeting.streamCallId`
 * stores the BARE id, which carries no type at all, so that read would answer
 * `default` for every row and quietly reproduce the bug this removes.
 *
 * `default` remains the fallback when the column cannot be read. A row we cannot
 * type is a row we address conservatively — the type every call before the
 * cutover is on — and `default` is that type. The read failing is not silent:
 * a null row means a Meeting the guard just resolved access for is missing,
 * which is worth a line in the log.
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

    // A participant is authorized to BE in this call and not to close it. The
    // distinction is the whole point of the route, so it gets its own refusal
    // rather than reusing the access one.
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

    // Database only, and before any provider call. `access.meetingId` is the row
    // itself, so this reads whichever room the row points at now — a #1607
    // rebuild moves `streamCallId` while the open tab still carries the old one.
    const meeting = await prisma.meeting.findUnique({
      where: { id: access.meetingId },
      select: { callType: true },
    });
    if (!meeting) {
      streamLogger.error(
        "Meeting row vanished between the access check and end",
        {
          userId,
          meetingId,
        },
      );
    }
    const callType = normalizeCallType(meeting?.callType);

    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(callType, toCallId(access.streamCallId))
        .end(),
    );

    streamLogger.info("Meeting ended by host", {
      userId,
      meetingId,
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
