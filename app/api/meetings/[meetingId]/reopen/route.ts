import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  REJOIN_GRACE_MS,
  isDeadOccurrence,
  isDeliberateEnd,
} from "@/lib/appointments/occurrences";
import { isCancelledLikeStatus } from "@/lib/appointments/status";
import { isPresenterRole } from "@/lib/collaborators/roles";
import { hasStreamConsent } from "@/lib/meetings/access";
import { meetingIdParamSchema } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

async function isAuthorizedReopenHost(
  userId: string,
  occurrenceConsultantProfileId: string | null | undefined,
  appt: {
    consultation?: {
      consultationPlan?: { consultantProfileId?: string | null } | null;
    } | null;
    subscription?: {
      subscriptionPlan?: { consultantProfileId?: string | null } | null;
    } | null;
    webinar?: {
      webinarPlan?: {
        id: string;
        consultantProfileId?: string | null;
      } | null;
    } | null;
    class?: {
      classPlan?: {
        id: string;
        consultantProfileId?: string | null;
      } | null;
    } | null;
    trial?: {
      consultantProfileId?: string | null;
      subscriptionPlan?: { consultantProfileId?: string | null } | null;
    } | null;
  },
): Promise<boolean> {
  const userRecord = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });
  const profileId = userRecord?.consultantProfileId;
  if (!profileId) return false;

  const planOwnerId =
    appt.consultation?.consultationPlan?.consultantProfileId ??
    appt.subscription?.subscriptionPlan?.consultantProfileId ??
    appt.webinar?.webinarPlan?.consultantProfileId ??
    appt.class?.classPlan?.consultantProfileId ??
    appt.trial?.consultantProfileId ??
    appt.trial?.subscriptionPlan?.consultantProfileId ??
    null;

  if (
    profileId === planOwnerId ||
    profileId === occurrenceConsultantProfileId
  ) {
    return true;
  }

  const webinarPlanId = appt.webinar?.webinarPlan?.id;
  const classPlanId = appt.class?.classPlan?.id;
  if (!webinarPlanId && !classPlanId) return false;

  const collab = await prisma.collaborator.findFirst({
    where: {
      consultantProfileId: profileId,
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null },
      ...(webinarPlanId ? { webinarPlanId } : { classPlanId }),
    },
    select: { role: true },
  });
  return Boolean(collab && isPresenterRole(collab.role));
}

function isAppointmentInactiveForReopen(appt: {
  deletedAt?: Date | null;
  consultation?: { status?: string | null } | null;
  subscription?: { status?: string | null } | null;
  webinar?: { status?: string | null } | null;
  class?: { status?: string | null } | null;
  trial?: { status?: string | null } | null;
}): boolean {
  if (appt.deletedAt) return true;
  const bookingStatus =
    appt.consultation?.status ??
    appt.subscription?.status ??
    appt.webinar?.status ??
    appt.class?.status ??
    appt.trial?.status ??
    null;
  return Boolean(bookingStatus && isCancelledLikeStatus(bookingStatus));
}

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

    if (!(await hasStreamConsent(user.id))) {
      return NextResponse.json(
        {
          error: "Stream data-processing consent is required to reopen calls.",
        },
        { status: 403 },
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
                  select: {
                    status: true,
                    consultationPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                subscription: {
                  select: {
                    status: true,
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                webinar: {
                  select: {
                    status: true,
                    webinarPlan: {
                      select: {
                        id: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  select: {
                    status: true,
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
                    status: true,
                    consultantProfileId: true,
                    subscriptionPlan: {
                      select: { consultantProfileId: true },
                    },
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

    const isAuthorizedHost = await isAuthorizedReopenHost(
      user.id,
      meeting.occurrence.consultantProfileId,
      meeting.occurrence.appointment,
    );

    if (!isAuthorizedHost) {
      return NextResponse.json(
        { error: "Only the session host can reopen a closed room." },
        { status: 403 },
      );
    }

    if (
      isDeadOccurrence(meeting.occurrence) ||
      isAppointmentInactiveForReopen(meeting.occurrence.appointment)
    ) {
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

    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, nextCallId)
        .getOrCreate({
          data: {
            created_by_id: user.id,
            starts_at: startsAt,
            custom: {
              sessionStartsAt: startsAt.toISOString(),
              sessionEndsAt: endsAt.toISOString(),
            },
          },
        }),
    );

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
