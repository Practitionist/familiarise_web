import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { stageHostLiveBell } from "@/lib/meetings/host-live";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { reportSentryError } from "@/lib/observability/report";
import { meetingJoinLimiter } from "@/lib/rate-limit";
import { streamLogger } from "@/lib/stream-logger";

/**
 * POST /api/meetings/[meetingId]/host-live
 * The host's client calls this once its `call.join()` resolves; the first call per session rings the paid seats.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  try {
    const guard = await guardMeetingRoute(
      params,
      "admit to",
      meetingJoinLimiter,
    );
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;

    const occurrenceId = access.occurrence?.id;
    if (access.role !== "host" || access.coPresenter || !occurrenceId) {
      streamLogger.warn("Host-live refused — caller is not the plan's host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        {
          error: "Only the session's host can announce it.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    // A repeat finds the occurrence already claimed and stages nothing.
    const pages = await stageHostLiveBell(occurrenceId);
    await flushNotificationsAfter({ bells: pages }, "meetings.hostLive");
    return NextResponse.json({ announced: pages.length > 0 });
  } catch (error) {
    reportSentryError(error, { subsystem: "stream", op: "meetings.hostLive" });
    return NextResponse.json(
      { error: "Could not announce the session." },
      { status: 500 },
    );
  }
}
