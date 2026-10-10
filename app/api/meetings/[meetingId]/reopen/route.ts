import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  REJOIN_GRACE_MS,
  isDeadOccurrence,
  isDeliberateEnd,
} from "@/lib/appointments/occurrences";
import { isPresenterRole } from "@/lib/collaborators/roles";
import { meetingIdParamSchema } from "@/lib/meetings/route-guard";
import { isStreamConfigured } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

/**
 * POST /api/meetings/[meetingId]/reopen
 * Safety-valve endpoint allowing a session host to mint a fresh Stream call ID
 * (`occurrence-<id>-r<base36>`) and reopen a deliberately ended room while the
 * occurrence is still within its active `[startsAt - 15m, endsAt + 30m]` window.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { user } = authResult.session;

    const { meetingId: rawMeetingId } = await params;
    const parsed = meetingIdParamSchema.safeParse(rawMeetingId);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid meeting identifier." },
        { status: 400 },
      );
    }
    const callId = toCallId(parsed.data);
    meetingIdForLog = callId;

    if (!isStreamConfigured()) {
      return NextResponse.json(
        { error: "Video is not available right now." },
        { status: 503 },
      );
    }

    const meeting = await prisma.meeting.findUnique({
      where: { streamCallId: callId },
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        id: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        id: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                trial: {
                  select: {
                    consultantProfileId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!meeting) {
      return NextResponse.json(
        { error: "Meeting not found." },
        { status: 404 },
      );
    }

    const userRecord = await prisma.user.findUnique({
      where: { id: user.id },
      select: { consultantProfileId: true },
    });
    const appt = meeting.occurrence.appointment;
    const ownerProfileId =
      appt.consultation?.consultationPlan?.consultantProfileId ??
      appt.subscription?.subscriptionPlan?.consultantProfileId ??
      appt.webinar?.webinarPlan?.consultantProfileId ??
      appt.class?.classPlan?.consultantProfileId ??
      appt.trial?.consultantProfileId ??
      meeting.occurrence.consultantProfileId ??
      null;

    let isAuthorizedHost = Boolean(
      ownerProfileId && userRecord?.consultantProfileId === ownerProfileId,
    );

    if (!isAuthorizedHost && userRecord?.consultantProfileId) {
      const webinarPlanId = appt.webinar?.webinarPlan?.id;
      const classPlanId = appt.class?.classPlan?.id;
      if (webinarPlanId || classPlanId) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            consultantProfileId: userRecord.consultantProfileId,
            status: "ACCEPTED",
            consultantProfile: { deletedAt: null },
            ...(webinarPlanId ? { webinarPlanId } : { classPlanId }),
          },
          select: { role: true },
        });
        if (collab && isPresenterRole(collab.role)) {
          isAuthorizedHost = true;
        }
      }
    }

    if (!isAuthorizedHost) {
      return NextResponse.json(
        { error: "Only the session host can reopen a closed room." },
        { status: 403 },
      );
    }

    if (isDeadOccurrence(meeting.occurrence)) {
      return NextResponse.json(
        { error: "This session slot is no longer active." },
        { status: 409 },
      );
    }

    const startsAt = new Date(meeting.occurrence.startsAt);
    const endsAt = meeting.occurrence.endsAt
      ? new Date(meeting.occurrence.endsAt)
      : new Date(startsAt.getTime() + 60 * 60 * 1000);
    if (Date.now() > endsAt.getTime() + REJOIN_GRACE_MS) {
      return NextResponse.json(
        { error: "The rejoin grace window for this session has passed." },
        { status: 409 },
      );
    }

    if (!meeting.endedAt) {
      return NextResponse.json({
        reopened: false,
        streamCallId: meeting.streamCallId,
      });
    }

    if (
      !isDeliberateEnd({
        endedAt: meeting.endedAt,
        endedReason: meeting.endedReason,
      })
    ) {
      return NextResponse.json(
        { error: "This session is not eligible for reopening." },
        { status: 409 },
      );
    }

    const nextCallId = `occurrence-${meeting.occurrence.id}-r${Date.now().toString(36)}`;
    const updated = await prisma.meeting.updateMany({
      where: { id: meeting.id, endedAt: { not: null } },
      data: {
        streamCallId: nextCallId,
        endedAt: null,
        endedReason: null,
        isRecording: false,
      },
    });

    if (updated.count === 0) {
      const current = await prisma.meeting.findUnique({
        where: { id: meeting.id },
        select: { streamCallId: true },
      });
      return NextResponse.json({
        reopened: false,
        streamCallId: current?.streamCallId ?? meeting.streamCallId,
      });
    }

    streamLogger.info("Closed meeting room reopened by host", {
      userId: user.id,
      meetingId: meeting.id,
      previousCallId: meeting.streamCallId,
      streamCallId: nextCallId,
    });

    return NextResponse.json({
      reopened: true,
      streamCallId: nextCallId,
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "stream", op: "meetings.reopen" });
    streamLogger.error("Failed to reopen meeting room", {
      meetingId: meetingIdForLog,
      error,
    });
    return NextResponse.json(
      { error: "Could not reopen this session room. Please try again." },
      { status: 500 },
    );
  }
}
