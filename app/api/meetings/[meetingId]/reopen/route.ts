import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  REJOIN_GRACE_MS,
  isDeadOccurrence,
} from "@/lib/appointments/occurrences";
import { isCancelledLikeStatus } from "@/lib/appointments/status";
import { isPresenterRole } from "@/lib/collaborators/roles";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { hasStreamConsent } from "@/lib/meetings/access";
import {
  buildRoomCallPlan,
  readSlotForCaller,
  STREAM_SERVER_TRUSTED,
} from "@/lib/meetings/call-provisioning";
import { resolveRoomEndsAt } from "@/lib/meetings/duration-cap";
import { endAllowsHostReopen } from "@/lib/meetings/end-reasons";
import { meetingIdParamSchema } from "@/lib/meetings/route-guard";
import { applyRateLimit, meetingControlLimiter } from "@/lib/rate-limit";
import {
  getStreamVideoClient,
  isStreamConfigured,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  STREAM_CALL_TYPE,
  parseOccurrenceIdFromCallId,
  toCallId,
} from "@/lib/stream/call-cid";
import { assertValidGetOrCreateCall } from "@/lib/stream/video-contracts";
import { reportSentryError } from "@/lib/observability/report";

const PLAN_OWNER_SELECT = { select: { consultantProfileId: true } } as const;

const REOPEN_SELECT = {
  id: true,
  streamCallId: true,
  endedAt: true,
  endedReason: true,
  extendedSeconds: true,
  extensionsUsed: true,
  occurrence: {
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      completionStatus: true,
      deletedAt: true,
      consultantProfileId: true,
      appointment: {
        select: {
          deletedAt: true,
          consultation: {
            select: { status: true, consultationPlan: PLAN_OWNER_SELECT },
          },
          subscription: {
            select: { status: true, subscriptionPlan: PLAN_OWNER_SELECT },
          },
          webinar: {
            select: {
              status: true,
              webinarPlan: { select: { id: true, consultantProfileId: true } },
            },
          },
          class: {
            select: {
              status: true,
              classPlan: { select: { id: true, consultantProfileId: true } },
            },
          },
          trial: {
            select: {
              status: true,
              consultantProfileId: true,
              subscriptionPlan: PLAN_OWNER_SELECT,
            },
          },
        },
      },
    },
  },
} as const;

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

async function findMeetingForReopen(callId: string) {
  const occurrenceId = parseOccurrenceIdFromCallId(callId);
  return (
    (await prisma.meeting.findUnique({
      where: { streamCallId: callId },
      select: REOPEN_SELECT,
    })) ??
    (await prisma.meeting.findUnique({
      where: { id: callId },
      select: REOPEN_SELECT,
    })) ??
    (occurrenceId
      ? await prisma.meeting.findUnique({
          where: { appointmentOccurrenceId: occurrenceId },
          select: REOPEN_SELECT,
        })
      : null)
  );
}

/**
 * POST /api/meetings/[meetingId]/reopen
 * Lets a host reopen a room whose end allows it, inside `[startsAt - 15m, roomEndsAt + 30m]`.
 * The fresh Stream call is created first; the Meeting rotates to it only once it exists.
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

    const limited = await applyRateLimit(
      meetingControlLimiter,
      `user:${user.id}`,
      "meetings",
    );
    if (limited) return limited;

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

    const meeting = await findMeetingForReopen(callId);
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

    const roomEndsAt = resolveRoomEndsAt(
      meeting.occurrence.endsAt,
      meeting.extendedSeconds,
    );
    if (Date.now() > roomEndsAt.getTime() + REJOIN_GRACE_MS) {
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

    if (!endAllowsHostReopen(meeting)) {
      return NextResponse.json(
        { error: "This session is not eligible for reopening." },
        { status: 409 },
      );
    }

    const authorized = await readSlotForCaller(meeting.occurrence.id);
    if (!authorized) {
      return NextResponse.json(
        { error: "Only the session host can reopen a closed room." },
        { status: 403 },
      );
    }
    const { authorUserId, payload } = await buildRoomCallPlan(authorized, {
      extendedSeconds: meeting.extendedSeconds,
      extensionsUsed: meeting.extensionsUsed,
    });

    const nextCallId = `occurrence-${meeting.occurrence.id}-r${Date.now().toString(36)}`;
    await upsertUsersToStream([authorUserId], {
      serverTrusted: STREAM_SERVER_TRUSTED,
    });
    assertValidGetOrCreateCall(payload);
    await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, nextCallId)
        .getOrCreate(payload),
    );

    const updated = await prisma.meeting.updateMany({
      where: {
        id: meeting.id,
        streamCallId: meeting.streamCallId,
        endedAt: meeting.endedAt,
        // A room whose attendance settled while this waited on Stream stays closed; its record names only the old call.
        attendanceSettledAt: null,
      },
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
      streamLogger.info("Reopen lost the race; the fresh call stays unused", {
        meetingId: meeting.id,
        unusedCallId: nextCallId,
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
    if (error instanceof StreamUnavailableError) {
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }
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
