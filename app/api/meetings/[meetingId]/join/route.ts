import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { resolveMeetingAccess } from "@/lib/meetings/access";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/join
 *
 * #1134 P0-1 — the join gate, and the only way to become a member of a call.
 *
 * Access control on video used to be a React conditional: the page rendered
 * "Access Denied" while the Stream token authorized every call in the app, so
 * `client.call(type, id).join()` from devtools walked into any consultation. Two
 * changes close it, and both are required:
 *
 *   1. `join-call` moves off the plain `user` role onto `call_member`
 *      (scripts/stream/ensure-call-type-grants.ts). Stream now refuses a
 *      non-member itself, whatever the UI does.
 *   2. This route is the sole grantor of membership, and it grants only after
 *      resolveMeetingAccess confirms the caller is on THIS appointment.
 *
 * Membership rather than a call-scoped token, deliberately: the video client is
 * an app-wide singleton holding one user token (that singleton is what fixed the
 * #248 remount storm), and the JS SDK has no per-call token on a shared client.
 * Minting a `call_cids` token would mean a second client per meeting. Granting
 * membership server-side gets the same property — Stream enforces the boundary,
 * and only an authorized server call can move it — without touching the
 * connection architecture. It is also what Stream's own "restrict access to a
 * call to a specific set of users" guidance describes.
 *
 * Granting on every join also repairs calls that were minted without members
 * (the `?? slot` anchor fallback in lib/meeting.ts, and everything created
 * before members were named at all).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // A suspended user must not be re-admitted to a call (#693).
    if (session.user.banned) {
      return NextResponse.json({ error: "Account suspended" }, { status: 403 });
    }

    const { meetingId } = await params;
    if (!meetingId) {
      return NextResponse.json(
        { error: "Meeting ID is required" },
        { status: 400 },
      );
    }

    if (!isStreamConfigured()) {
      streamLogger.error("Stream not configured — cannot admit to meeting");
      return NextResponse.json(
        { error: "Video is not available" },
        { status: 503 },
      );
    }

    const access = await resolveMeetingAccess(meetingId, session.user.id);

    if (!access.hasAccess) {
      // A real status code, not a 200 with a flag. This is the security
      // boundary: a denial has to be unmistakable to the client and greppable
      // in logs.
      streamLogger.warn("Meeting join refused", {
        userId: session.user.id,
        meetingId,
        reason: access.message,
      });
      return NextResponse.json(
        { error: access.message },
        { status: access.message === "Meeting not found" ? 404 : 403 },
      );
    }

    // Hosts get the elevated role so they can end the call for everyone and
    // control recording; everyone else joins as a plain member.
    const role = access.role === "host" ? "host" : "user";

    await withStreamCircuitBreaker(async () => {
      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        meetingId,
      );
      // Idempotent: re-adding an existing member updates their role rather than
      // erroring, so a rejoin is a no-op.
      await call.updateCallMembers({
        update_members: [{ user_id: session.user.id, role }],
      });
    });

    streamLogger.info("Admitted to meeting", {
      userId: session.user.id,
      meetingId,
      role: access.role,
    });

    return NextResponse.json({
      callType: STREAM_CALL_TYPE,
      callId: meetingId,
      role: access.role,
    });
  } catch (error) {
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
