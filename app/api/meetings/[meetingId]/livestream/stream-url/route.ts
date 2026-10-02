import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  assertSameOrganization,
  readLivestreamMeetingRow,
  resolveHlsUrl,
  type LivestreamRefusal,
} from "@/lib/meetings/livestream-service";
import { StreamUnavailableError } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { reportSentryError } from "@/lib/observability/report";

/**
 * GET /api/meetings/[meetingId]/livestream/stream-url
 *
 * ## The response body is a bearer credential
 *
 * `playlist_url` is not a link to a page. It is the key to the stream: the CDN
 * serves it with no token, no session and no membership check, because a
 * playlist URL cannot carry one and Stream does not sit in the request path.
 * Whoever holds it is watching. There is no second factor behind it — no
 * refresh, no expiry we control, no revocation short of stopping the egress —
 * and Stream's own retention on the object outlives the broadcast.
 *
 * So this route is the whole consent boundary, and every decision about it is
 * deliberately boring:
 *
 *   - `guardMeetingRoute` runs FIRST, before the body is even read, and it is
 *     the same resolver the join gate uses. Anyone not on this appointment gets
 *     the 403/404 that resolver produces and never learns whether the session
 *     is broadcast, who is in it, or whether it is live.
 *   - `Cache-Control: no-store` on every response, success and failure alike.
 *     One missing header on one status code is enough for a shared cache or a
 *     browser disk cache to keep a credential after the broadcast ended, and
 *     the participants are the same people who will be in the room again.
 *   - the URL is never logged, never included in an error message, and never
 *     returned from anywhere else in the app.
 *
 * ## 404, not 403, for a session that is not a broadcast
 *
 * A non-broadcast meeting here is indistinguishable, on purpose, from a
 * meeting that does not exist. `not_livestream` therefore answers 404 rather
 * than the 409 the sibling route uses for the same reason: this endpoint's
 * existence and its answers should not be a directory of which sessions are
 * webinars.
 */

/**
 * The headers every response here carries.
 *
 * Applied to the refusals as well as the success, which is the part that is
 * easy to drop: a 403 is exactly what a shared cache is most likely to keep,
 * and a cached 403 that later flips to a 200 (or the reverse) is a
 * credential-lifetime bug wearing a correctness costume.
 */
const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  // Belt and braces for HTTP/1.1 intermediaries that cache on the legacy
  // pair instead of Cache-Control.
  Pragma: "no-cache",
  Expires: "0",
} as const;

const STATUS_BY_REASON: Record<LivestreamRefusal["reason"], number> = {
  // 404 here, not the sibling route's 409: see the header.
  not_livestream: 404,
  // Same reasoning — the room's absence is not this endpoint's business, and a
  // retryable 409 would tell a participant their own session is broken.
  no_call: 404,
  not_host: 403,
  hls_unavailable: 404,
  stream_unreachable: 503,
};

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  // Hoisted for the catch, and the id only — never the URL. Mirrors the join
  // and end routes.
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "watch the livestream");
    if (!guard.ok) {
      // The guard's own response has no cache header on it, and it is a
      // membership decision about a participant — reissued through `json` so
      // it cannot be stored either.
      return NextResponse.json(
        { error: "Not available", reason: "not_available" },
        { status: guard.response.status, headers: NO_STORE },
      );
    }
    const { meetingId, access } = guard;
    meetingIdForLog = meetingId;

    // Database only, by the row id the guard resolved rather than by the URL
    // segment (#C8 / #C9: the segment is a call id of unknown vintage, and the
    // row is what names the room NOW).
    const meeting = await readLivestreamMeetingRow(access.meetingId);
    if (!meeting) {
      return json({ error: "Not found", reason: "not_found" }, 404);
    }

    // The explicit tenant check, identical to the one on the POST route. The
    // stamp is what every org authorisation reads, so a row where it disagrees
    // with the owning appointment is refused rather than resolved.
    if (assertSameOrganization(meeting)) {
      return json({ error: "Not found", reason: "not_found" }, 404);
    }

    const outcome = await resolveHlsUrl({ meeting });
    if (!outcome.ok) {
      streamLogger.info("Refused an HLS playback URL", {
        meetingId,
        reason: outcome.reason,
      });
      return json(
        {
          error: "No stream is available for this session.",
          reason: outcome.reason,
        },
        STATUS_BY_REASON[outcome.reason],
      );
    }

    return json(
      { playlistUrl: outcome.playlistUrl, status: outcome.hlsStatus },
      200,
    );
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Stream URL unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return json(
        { error: "Video is temporarily unavailable. Please try again." },
        503,
      );
    }

    // No error message reaches Sentry with the URL in it: the failure above is
    // the vendor's, and the vendor's payload is the one thing here capable of
    // echoing a credential back. The op tag says which call failed.
    reportSentryError(error, {
      subsystem: "stream",
      op: "meetings.livestream.streamUrl",
    });
    streamLogger.error("Failed to resolve an HLS playback URL", error, {
      meetingId: meetingIdForLog,
    });
    return json(
      { error: "Could not reach the stream right now. Please try again." },
      500,
    );
  }
}
