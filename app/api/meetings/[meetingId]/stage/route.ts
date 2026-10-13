import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { liveParticipant } from "@/lib/booking/participants";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { isOneToManyAppointmentType } from "@/lib/meetings/room-ready";
import prisma from "@/lib/prisma";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import {
  assertValidUpdateUserPermissions,
  STREAM_PUBLISH_PERMISSIONS,
} from "@/lib/stream/video-contracts";
import { reportSentryError } from "@/lib/observability/report";

const stageRequestSchema = z.object({
  targetUserId: z.string().trim().min(1, "targetUserId is required"),
  action: z.enum(["grant", "revoke"]),
  permissions: z.array(z.enum(STREAM_PUBLISH_PERMISSIONS)).min(1).optional(),
});

/**
 * POST /api/meetings/[meetingId]/stage
 * Server-side stage moderation route for Webinar and Class sessions.
 * Allows any verified host (plan owner, accepted co-presenter collaborator, or
 * occurrence-assigned org consultant) to approve or decline attendee stage requests
 * even when they are not the Stream call's `created_by` user.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "admit to");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    if (access.role !== "host") {
      streamLogger.warn(
        "Meeting stage moderation refused — caller is not the host",
        {
          userId,
          meetingId,
          role: access.role,
        },
      );
      return NextResponse.json(
        {
          error:
            "Only a host or co-presenter can manage stage permissions for this session.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    const appointmentType =
      access.appointment?.appointmentType ??
      (access.appointment?.webinar
        ? "WEBINAR"
        : access.appointment?.class
          ? "CLASS"
          : null);
    if (appointmentType && !isOneToManyAppointmentType(appointmentType)) {
      return NextResponse.json(
        {
          error: "Stage moderation is only used for webinar and class rooms.",
        },
        { status: 400 },
      );
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = stageRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid stage permission request.",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { targetUserId, action } = parsed.data;
    const appointmentId = access.appointment?.id;
    if (appointmentId) {
      const targetSeat = await prisma.appointmentParticipant.findFirst({
        where: { appointmentId, ...liveParticipant(targetUserId) },
        select: { id: true },
      });
      if (!targetSeat) {
        return NextResponse.json(
          {
            error: "Target user is not an active participant of this session.",
            reason: "target_not_participant",
          },
          { status: 403 },
        );
      }
    }
    const permissions =
      parsed.data.permissions ??
      (action === "revoke"
        ? [...STREAM_PUBLISH_PERMISSIONS]
        : ["send-audio", "send-video"]);
    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);

    const permissionPayload =
      action === "grant"
        ? { user_id: targetUserId, grant_permissions: permissions }
        : { user_id: targetUserId, revoke_permissions: permissions };

    assertValidUpdateUserPermissions(permissionPayload);

    await withStreamCircuitBreaker(async () => {
      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        resolvedCallId,
      );
      await call.updateUserPermissions(permissionPayload);
    });

    streamLogger.info("Updated attendee stage permissions", {
      hostUserId: userId,
      targetUserId,
      action,
      permissions,
      meetingId: resolvedCallId,
    });

    return NextResponse.json({
      updated: true,
      callId: resolvedCallId,
      targetUserId,
      action,
      permissions,
    });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting stage update unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, { subsystem: "stream", op: "meetings.stage" });
    streamLogger.error("Failed to update stage permissions", error);
    return NextResponse.json(
      { error: "Could not update stage permissions. Please try again." },
      { status: 500 },
    );
  }
}
