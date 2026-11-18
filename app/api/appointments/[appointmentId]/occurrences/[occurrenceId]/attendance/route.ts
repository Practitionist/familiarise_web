import { NextResponse } from "next/server";

import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { readSessionAttendance } from "@/lib/booking/session-attendance";
import {
  appointmentPlanRef,
  resolveCollaborationViewer,
  seesAttendees,
} from "@/lib/collaborators/viewer";
import prisma from "@/lib/prisma";

const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * GET: per-seat present minutes for one session, host side only. On a webinar
 * or class that is the plan's manager and a presenter; crew do not read it.
 */
export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; occurrenceId: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { appointmentId, occurrenceId } = await params;
  const viewerUserId = auth.session.user.id;

  let privileged = isPrivileged(auth.session.user.role);
  if (!privileged) {
    const planRef = await appointmentPlanRef(prisma, appointmentId);
    if (planRef) {
      const { viewer } = await resolveCollaborationViewer(
        prisma,
        planRef,
        viewerUserId,
      );
      if (!seesAttendees(viewer)) return notFound();
      // The team rule has answered; the 1:1 host test below does not apply.
      privileged = true;
    }
  }

  const attendance = await readSessionAttendance({
    appointmentId,
    occurrenceId,
    viewerUserId,
    privileged,
  });
  if (!attendance) return notFound();
  return NextResponse.json(attendance, {
    headers: { "Cache-Control": "no-store" },
  });
}
