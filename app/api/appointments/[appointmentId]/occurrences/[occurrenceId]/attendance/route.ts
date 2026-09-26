import { NextResponse } from "next/server";

import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { readSessionAttendance } from "@/lib/booking/session-attendance";

/** GET — #1569 B-4: per-seat present minutes for one session, host side only. */
export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; occurrenceId: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { appointmentId, occurrenceId } = await params;
  const attendance = await readSessionAttendance({
    appointmentId,
    occurrenceId,
    viewerUserId: auth.session.user.id,
    privileged: isPrivileged(auth.session.user.role),
  });
  if (!attendance) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(attendance, {
    headers: { "Cache-Control": "no-store" },
  });
}
