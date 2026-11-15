import { NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { meetingStageLimiter } from "@/lib/rate-limit";
import { caseKeyOf } from "@/lib/support/case-key";

/**
 * GET /api/meetings/[meetingId]/support — the support page for this room's
 * booking, for anyone the room admits who wants to report a concern.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const guard = await guardMeetingRoute(
    params,
    "admit to",
    meetingStageLimiter,
  );
  if (!guard.ok) return guard.response;
  const appointmentId = guard.access.appointment?.id;
  if (!appointmentId) {
    return NextResponse.json(
      { error: "This room has no booking to report on." },
      { status: 404 },
    );
  }
  return NextResponse.json({
    href: `/dashboard/support/${caseKeyOf({ kind: "booking", id: appointmentId })}`,
  });
}
