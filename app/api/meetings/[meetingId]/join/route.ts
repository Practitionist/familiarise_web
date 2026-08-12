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
        reason: access.reason,
      });
      return NextResponse.json(
        { error: access.message, reason: access.reason },
        { status: access.reason === "not_found" ? 404 : 403 },
      );
    }

    // ALWAYS `call_member`, for both sides. Verified against the live call type
    // rather than assumed: the `default` grants map has exactly six role keys —
    // guest, user, call_member, admin, global_read_only, global_admin. There is
    // no `host` key. An earlier draft assigned `"host"` to consultants and
    // `"user"` to everyone else, which would have locked out BOTH the moment
    // ensure-call-type-grants strips join-call from `user`: `host` has no grants
    // at all, and `user` would no longer have any either. That is a total video
    // outage disguised as a security fix.
    //
    // Nothing is lost. `call_member` is a strict superset of `user` on the live
    // type, and host-ness in the UI is derived from `custom.consultantUserId`
    // via useCallCustomData(), never from the Stream role.
    const role = "call_member";

    await withStreamCircuitBreaker(async () => {
      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        meetingId,
      );

      // A MeetingSession row does not guarantee the Stream call exists, and
      // updateCallMembers on a missing call throws — which this route reports as
      // a 500 after resolveMeetingAccess has already told the user they are
      // allowed in. Three ways a row outlives (or precedes) its call: the seeds
      // mint `MeetingSession` rows with faker ids and no Stream object at all;
      // `createDbMeetingSession` is a "use server" action whose id validator is
      // `z.string().min(1)`, so an entitled caller can write any string; and
      // maintenance drain ends the call while keeping the row. lib/meeting.ts
      // skips its own getOrCreate whenever a row already exists, and P0-2 removed
      // the client-side getOrCreate that used to paper over all three.
      //
      // Creating here is NOT a P0-2 regression. P0-2 was the client minting a
      // billable call from an effect that raced the access check, so an
      // unauthorized visitor became `created_by` of a call that should not exist.
      // This runs only after resolveMeetingAccess has confirmed the caller is on
      // this appointment — authorization first, creation second, which is the
      // ordering P0-2 was about.
      await call.getOrCreate();

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
