import { NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { handleConductRemoval } from "@/lib/api/participants/group-participants-route";
import { meetingIdParamSchema } from "@/lib/meetings/route-guard";
import prisma from "@/lib/prisma";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";

/**
 * POST /api/meetings/[meetingId]/remove — the live room's door to a conduct
 * removal: the same rule and the same transaction as the roster's.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;
  const meetingId = meetingIdParamSchema.safeParse((await params).meetingId);
  if (!meetingId.success) {
    return NextResponse.json(
      { error: "Meeting ID is required" },
      { status: 400 },
    );
  }
  const meeting = await prisma.meeting.findFirst({
    where: { OR: [{ streamCallId: meetingId.data }, { id: meetingId.data }] },
    select: { occurrence: { select: { appointmentId: true } } },
  });
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }
  return handleConductRemoval(
    request,
    session,
    meeting.occurrence.appointmentId,
  );
}
