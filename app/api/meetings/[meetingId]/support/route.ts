import { NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import prisma from "@/lib/prisma";
import { meetingStageLimiter } from "@/lib/rate-limit";
import { caseKeyOf } from "@/lib/support/case-key";

/**
 * GET /api/meetings/[meetingId]/support — this booking's support request page
 * in the caller's own dashboard: the host's expert tree, an attendee's client tree.
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
  const user = await prisma.user.findUnique({
    where: { id: guard.userId },
    select: { consultantProfileId: true, consulteeProfileId: true },
  });
  const key = caseKeyOf({ kind: "booking", id: appointmentId });
  const tree =
    guard.access.role === "host" && user?.consultantProfileId
      ? `/dashboard/consultant/${user.consultantProfileId}`
      : user?.consulteeProfileId
        ? `/dashboard/consultee/${user.consulteeProfileId}`
        : user?.consultantProfileId
          ? `/dashboard/consultant/${user.consultantProfileId}`
          : null;
  if (!tree) {
    return NextResponse.json(
      { error: "Open support from your dashboard." },
      { status: 404 },
    );
  }
  return NextResponse.json({ href: `${tree}/support/requests/${key}` });
}
