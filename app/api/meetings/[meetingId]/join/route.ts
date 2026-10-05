import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { isOneToManyAppointmentType } from "@/lib/meetings/room-ready";
import {
  getStreamVideoClient,
  streamErrorCode,
  streamHttpStatus,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import {
  CALL_MEMBER_ROLE,
  CO_PRESENTER_CALL_ROLE,
  STREAM_CALL_TYPE,
  toCallId,
} from "@/lib/stream/call-cid";
import {
  STREAM_PUBLISH_PERMISSIONS,
  assertValidUpdateCallMembers,
  assertValidUpdateUserPermissions,
} from "@/lib/stream/video-contracts";
import { reportSentryError } from "@/lib/observability/report";

/** The only capabilities Stream's UpdateUserPermissions accepts; any other name fails the whole request. */
const PUBLISH_PERMISSIONS = STREAM_PUBLISH_PERMISSIONS;

/**
 * POST /api/meetings/[meetingId]/join
 * Verifies meeting access and DPDP consent, upserts the caller on Stream, and grants call membership
 * (`co_presenter` for accepted presenter collaborators, else `call_member`). It never creates the call;
 * provisioning is the only creator. Attendance is recorded by the session participant webhooks.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  let meetingIdForLog: string | undefined;
  try {
    const guard = await guardMeetingRoute(params, "admit to");
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    const role = access.coPresenter ? CO_PRESENTER_CALL_ROLE : CALL_MEMBER_ROLE;
    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);

    const admitted = await withStreamCircuitBreaker(async () => {
      await upsertUsersToStream([userId]);

      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        resolvedCallId,
      );

      const addMember = (memberRole: string) => {
        const memberPayload = {
          update_members: [{ user_id: userId, role: memberRole }],
        };
        assertValidUpdateCallMembers(memberPayload);
        return call.updateCallMembers(memberPayload);
      };
      try {
        await addMember(role).catch(async (error: unknown) => {
          // An app missing the custom role still admits the presenter as a plain member.
          if (
            role !== CO_PRESENTER_CALL_ROLE ||
            streamHttpStatus(error) !== 400
          )
            throw error;
          reportSentryError(error, {
            subsystem: "stream",
            op: "meetings.join.coPresenterRole",
            extra: { meetingId: resolvedCallId },
          });
          await addMember(CALL_MEMBER_ROLE);
        });
      } catch (error) {
        // Only Stream's not-found (HTTP 404 with code 16) on the membership write proves the call is missing.
        if (streamHttpStatus(error) === 404 && streamErrorCode(error) === 16)
          return false;
        throw error;
      }

      const appointmentType =
        access.appointment?.appointmentType ??
        (access.appointment?.webinar
          ? "WEBINAR"
          : access.appointment?.class
            ? "CLASS"
            : null);
      const isOneToMany = isOneToManyAppointmentType(appointmentType);

      if (isOneToMany && access.role === "host") {
        const grantPayload = {
          user_id: userId,
          grant_permissions: [...PUBLISH_PERMISSIONS],
        };
        assertValidUpdateUserPermissions(grantPayload);
        await call.updateUserPermissions(grantPayload);
      } else if (isOneToMany) {
        const revokePayload = {
          user_id: userId,
          revoke_permissions: [...PUBLISH_PERMISSIONS],
        };
        assertValidUpdateUserPermissions(revokePayload);
        await call.updateUserPermissions(revokePayload);
      }
      return true;
    });

    if (!admitted) {
      reportSentryError(new Error("ROOM_NOT_PROVISIONED"), {
        subsystem: "stream",
        op: "meetings.join",
        extra: { meetingId },
      });
      return NextResponse.json(
        {
          error:
            "This session's video room is not available. Please contact support.",
          code: "ROOM_NOT_PROVISIONED",
        },
        { status: 409 },
      );
    }

    streamLogger.info("Admitted to meeting", {
      userId,
      meetingId: resolvedCallId,
      role: access.role,
    });

    return NextResponse.json({
      callType: STREAM_CALL_TYPE,
      callId: resolvedCallId,
      role: access.role,
    });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting join unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, {
      subsystem: "stream",
      op: "meetings.join",
    });
    streamLogger.error("Failed to admit to meeting", error);
    return NextResponse.json(
      { error: "Could not join this meeting. Please try again." },
      { status: 500 },
    );
  }
}
