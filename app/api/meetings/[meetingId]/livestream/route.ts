import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  assertSameOrganization,
  endLive,
  goLive,
  readLivestreamMeetingRow,
  type LivestreamRefusal,
} from "@/lib/meetings/livestream-service";
import { StreamUnavailableError } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/livestream — `{"action":"go-live"}` or
 * `{"action":"end"}`.
 *
 * The broadcast equivalent of `join` and `end`, and gated by the same guard, in
 * the same order, for the same reason: #1134 P0-1 was a video call whose only
 * access control was a React conditional, and a second authorization preamble
 * for the livestream half is how it comes back.
 *
 * ## Who may press the button
 *
 * `resolveMeetingAccess`'s own `host` role — the plan owner or an accepted
 * presenter collaborator — and nothing else. Deliberately narrower than
 * `endLive`, which additionally accepts an org operator: this route is also the
 * go-live side, and an org administrator taking a client webinar live is not
 * something they were asked to be able to do. A broader grant belongs on the
 * narrower verb.
 *
 * Note what is NOT consulted: nothing the client sent. No `role`, no `isHost`,
 * no call id. `guardMeetingRoute` resolves all of that from the database, and
 * the host designation `goLive` writes is server-side too.
 *
 * ## Organisational scoping is explicit
 *
 * Three separate things have to agree before any provider call happens, and the
 * route checks all of them rather than trusting the chain:
 *
 *   1. `guardMeetingRoute` — the caller is on THIS appointment. That already
 *      excludes a member of another org, and nothing below weakens it.
 *   2. `readLivestreamMeetingRow(access.meetingId)` — the row the guard resolved,
 *      by row id and not by the URL segment, so a stale or rebuilt room id in a
 *      copied link cannot address a different call.
 *   3. `assertSameOrganization` — the tenant key stamped on the Meeting agrees
 *      with the appointment that owns it. Every org authorisation downstream
 *      reads the stamp, so a row where the two disagree is refused outright
 *      rather than resolved in favour of one of them.
 *
 * ## Status codes
 *
 * `not_livestream` is a 409 and not a 403. The caller may perfectly well be the
 * host of a consultation; they asked to broadcast something that is not a
 * broadcast, and answering "forbidden" would report a permission problem for a
 * request that is really a wrong-target problem. `stream_unreachable` is a 503
 * for the same reason the join route uses one — a provider outage is not our
 * bug and should not land in the 5xx bucket that means "we broke something".
 */

const bodySchema = z.object({
  action: z.enum(["go-live", "end"]),
});

const STATUS_BY_REASON: Record<LivestreamRefusal["reason"], number> = {
  // The room exists and the caller may well be its host; it is simply not a
  // broadcast. A conflict with the resource's state, not an auth failure.
  not_livestream: 409,
  // A Meeting row with no minted call yet — #C1's normal state for a session
  // whose first mint failed. Retryable by the next person to walk in.
  no_call: 409,
  not_host: 403,
  // The call is live but there is no playlist behind it, which is a question
  // about the broadcast rather than about the caller. Retryable: the presenter
  // may not have started the egress yet.
  hls_unavailable: 409,
  stream_unreachable: 503,
};

function refuse(refusal: LivestreamRefusal): NextResponse {
  return NextResponse.json(
    { error: refusal.message, reason: refusal.reason },
    { status: STATUS_BY_REASON[refusal.reason] },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  // Hoisted for the catch: re-awaiting `params` there would rethrow if `params`
  // itself was what failed. Mirrors the join and end routes.
  let meetingIdForLog: string | undefined;
  try {
    // The body is read BEFORE the guard so a malformed request is a 400 rather
    // than a database round trip per stray POST — and so the guard's `op` can
    // name the action that was actually asked for.
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'action must be "go-live" or "end"' },
        { status: 400 },
      );
    }
    const action = parsed.data.action;

    const guard = await guardMeetingRoute(
      params,
      action === "go-live" ? "go live" : "end the livestream",
    );
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    // Going live designates the caller as host, so it is the host's verb alone.
    // `endLive` re-derives hostness from the call rather than accepting this
    // route's answer; the check here is what stops a participant from reaching
    // `goLive` at all, where the designation would then be theirs.
    if (access.role !== "host") {
      streamLogger.warn("Livestream action refused — caller is not the host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        { error: "Only the host can do that.", reason: "not_host" },
        { status: 403 },
      );
    }

    // Database only — no provider is touched until the guard above has answered.
    // Read by `access.meetingId` (the ROW) rather than by the URL segment,
    // which is a call id of unknown vintage and the reason #C8 and #C9 exist.
    const meeting = await readLivestreamMeetingRow(access.meetingId);
    if (!meeting) {
      return NextResponse.json(
        { error: "Meeting not found", reason: "not_found" },
        { status: 404 },
      );
    }

    // The explicit tenant check. `not_livestream` is the reason it carries, but
    // it is a 404 and not a 409 — from outside, this meeting does not exist.
    const orgMismatch = assertSameOrganization(meeting);
    if (orgMismatch) {
      return NextResponse.json(
        { error: "Meeting not found", reason: "not_found" },
        { status: 404 },
      );
    }

    const outcome =
      action === "go-live"
        ? await goLive({ meeting, hostUserId: userId })
        : await endLive({ meeting, actorUserId: userId });

    if (!outcome.ok) return refuse(outcome);

    return NextResponse.json({
      action,
      callType: outcome.callType,
      callId: outcome.callId,
      ...("hls" in outcome ? { hls: outcome.hls } : {}),
    });
  } catch (error) {
    // The breaker's own throw. Both verbs surface it as `stream_unreachable`,
    // which maps to 503 above — handled here only so the fast-fail path does not
    // pay for a Sentry event.
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Livestream action unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, {
      subsystem: "stream",
      op: "meetings.livestream",
    });
    streamLogger.error("Livestream action failed", error, {
      meetingId: meetingIdForLog,
    });
    return NextResponse.json(
      { error: "Could not reach the broadcast service. Please try again." },
      { status: 500 },
    );
  }
}
