import { requireApiAuth } from "@/lib/auth-helpers";
import { NextResponse } from "next/server";

import { resolveMeetingAccess } from "@/lib/meetings/access";
import type { MeetingAccess } from "@/lib/meetings/access";
import { isStreamConfigured } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";

/**
 * The five questions every meeting route asks before it touches Stream.
 *
 * #1270 — `join` and `end` had asked them in exactly the same order, in
 * duplicate: authenticated, not suspended, meeting id present, Stream
 * configured, and access resolved from the database. Two copies of an
 * authorization preamble is how the two routes drift, and the drift would be
 * silent — a guard added to one and not the other looks like nothing at all in
 * a diff. It lives here once, and a third route gets it for free.
 *
 * Returns a discriminated union rather than throwing: a refusal here is an
 * ordinary outcome with a status code attached, and making the caller handle it
 * explicitly keeps that visible at the call site.
 */
export type MeetingRouteRefusal = { ok: false; response: NextResponse };

export type MeetingRouteGrant = {
  ok: true;
  userId: string;
  meetingId: string;
  access: Extract<MeetingAccess, { streamCallId: string }>;
};

export async function guardMeetingRoute(
  params: Promise<{ meetingId: string }>,
  /** Named in the two log lines this emits, so a refusal says which route. */
  op: "admit to" | "end",
): Promise<MeetingRouteGrant | MeetingRouteRefusal> {
  const refuse = (body: Record<string, unknown>, status: number) => ({
    ok: false as const,
    response: NextResponse.json(body, { status }),
  });

  const authResult = await requireApiAuth();
  if (authResult.error) {
    return { ok: false, response: authResult.error };
  }
  const { session } = authResult;

  const { meetingId } = await params;
  if (!meetingId) {
    return refuse({ error: "Meeting ID is required" }, 400);
  }

  if (!isStreamConfigured()) {
    streamLogger.error(`Stream not configured — cannot ${op} meeting`);
    return refuse({ error: "Video is not available" }, 503);
  }

  const access = await resolveMeetingAccess(meetingId, session.user.id);

  if (!access.hasAccess) {
    // A real status code, not a 200 with a flag. This is the security
    // boundary: a denial has to be unmistakable to the client and greppable
    // in logs.
    streamLogger.warn(`Meeting ${op} refused`, {
      userId: session.user.id,
      meetingId,
      reason: access.reason,
    });
    return refuse(
      {
        error: access.message,
        reason: access.reason,
        ...("code" in access && access.code ? { code: access.code } : {}),
      },
      access.reason === "not_found" ? 404 : 403,
    );
  }

  return {
    ok: true,
    userId: session.user.id,
    meetingId,
    access,
  };
}
