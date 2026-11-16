import { NextRequest, NextResponse } from "next/server";

import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import { meetingJoinLimiter } from "@/lib/rate-limit";
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
import {
  fenceCollaboratorGrant,
  fenceSeatGrants,
} from "@/lib/stream/access-revocation";
import { captureThrottled } from "@/lib/observability/throttled-capture";

/** The only capabilities Stream's UpdateUserPermissions accepts; any other name fails the whole request. */
const PUBLISH_PERMISSIONS = STREAM_PUBLISH_PERMISSIONS;

/** A refusal repeating inside this window followed the client's self-heal provisioning, so the room is not coming. */
const ROOM_HEAL_WINDOW_MS = 120_000;
const lastRoomRefusalAt = new Map<string, number>();

/** First refusal of a meeting is the room awaiting the client's self-heal; a repeat inside the window is not. */
function isRepeatRoomRefusal(meetingId: string): boolean {
  const now = Date.now();
  for (const [id, at] of lastRoomRefusalAt) {
    if (now - at > ROOM_HEAL_WINDOW_MS) lastRoomRefusalAt.delete(id);
  }
  const repeat = lastRoomRefusalAt.has(meetingId);
  lastRoomRefusalAt.set(meetingId, now);
  return repeat;
}

/**
 * True only when Stream reports the user already holds `role`; any read failure answers false
 * so the membership write still runs.
 */
async function holdsCallRole(
  call: ReturnType<ReturnType<typeof getStreamVideoClient>["video"]["call"]>,
  userId: string,
  role: string,
): Promise<boolean> {
  try {
    const { members } = await call.queryMembers({
      filter_conditions: { user_id: userId },
      limit: 1,
    });
    return members.some(
      (member) => member.user_id === userId && member.role === role,
    );
  } catch {
    return false;
  }
}

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
    const guard = await guardMeetingRoute(
      params,
      "admit to",
      meetingJoinLimiter,
    );
    if (!guard.ok) return guard.response;
    const { userId, meetingId, access } = guard;
    meetingIdForLog = meetingId;

    const role = access.coPresenter ? CO_PRESENTER_CALL_ROLE : CALL_MEMBER_ROLE;
    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);

    const appointmentType =
      access.appointment?.appointmentType ??
      (access.appointment?.webinar
        ? "WEBINAR"
        : access.appointment?.class
          ? "CLASS"
          : null);

    await upsertUsersToStream([userId]);
    const appointmentId = access.appointment?.id;
    const grant = withStreamCircuitBreaker(async () => {
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
      // A 1-to-Many membership write is broadcast to the whole room, so a rejoin with the right role skips it.
      const alreadyMember = isOneToManyAppointmentType(appointmentType)
        ? await holdsCallRole(call, userId, role)
        : false;
      try {
        if (!alreadyMember) {
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
        }
      } catch (error) {
        // Only Stream's not-found (HTTP 404 with code 16) on the membership write proves the call is missing.
        if (streamHttpStatus(error) === 404 && streamErrorCode(error) === 16)
          return false;
        throw error;
      }

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
    let admitted: boolean;
    try {
      admitted = await grant;
    } catch (error) {
      // A membership that landed before a later write threw is re-checked like any other grant.
      if (appointmentId) await fenceSeatGrants(appointmentId, [userId]);
      if (access.collaboratorOf) {
        await fenceCollaboratorGrant(access.collaboratorOf, userId);
      }
      throw error;
    }

    if (!admitted) {
      if (isRepeatRoomRefusal(meetingId)) {
        captureThrottled(
          `meetings.join.roomNotProvisioned:${meetingId}`,
          new Error("ROOM_NOT_PROVISIONED"),
          { subsystem: "stream", op: "meetings.join", extra: { meetingId } },
        );
      } else {
        streamLogger.warn("Meeting room not provisioned; awaiting self-heal", {
          meetingId,
        });
      }
      return NextResponse.json(
        {
          error:
            "This session's video room is not available. Please contact support.",
          code: "ROOM_NOT_PROVISIONED",
          ...(access.occurrence?.id
            ? { occurrenceId: access.occurrence.id }
            : {}),
        },
        { status: 409 },
      );
    }

    // A cancel or refund that committed while this grant was in flight found no membership to remove.
    const fence = appointmentId
      ? await fenceSeatGrants(appointmentId, [userId])
      : null;
    if (fence?.verified && fence.lost.length > 0) {
      return NextResponse.json(
        { error: "This booking is no longer active.", code: "BOOKING_ENDED" },
        { status: 403 },
      );
    }
    // An unread seat check never admits a client; the sweep re-checks the grant that landed.
    if (fence && !fence.verified && access.role !== "host") {
      return NextResponse.json(
        {
          error: "We could not confirm your booking. Please try again.",
          code: "SEAT_UNVERIFIED",
        },
        { status: 503 },
      );
    }

    // A collaborator's access rests on their row alone: an ended one is taken back, an unread one is never admitted.
    const collaboratorFence = access.collaboratorOf
      ? await fenceCollaboratorGrant(access.collaboratorOf, userId)
      : null;
    if (collaboratorFence && !collaboratorFence.verified) {
      return NextResponse.json(
        {
          error: "We could not confirm your access. Please try again.",
          code: "COLLABORATION_UNVERIFIED",
        },
        { status: 503 },
      );
    }
    if (collaboratorFence?.lost) {
      return NextResponse.json(
        {
          error: "You are no longer on this session's team.",
          code: "COLLABORATION_ENDED",
        },
        { status: 403 },
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

    // A Stream 5xx or rate limit is the provider's outage; the client retries it.
    const upstream = streamHttpStatus(error);
    const providerOutage =
      upstream !== null && (upstream >= 500 || upstream === 429);

    // The client retries an outage, so only a non-outage fault reaches Sentry.
    if (providerOutage) {
      streamLogger.warn("Meeting join hit a Stream outage", {
        meetingId: meetingIdForLog,
        upstream,
      });
    } else {
      reportSentryError(error, {
        subsystem: "stream",
        op: "meetings.join",
      });
      streamLogger.error("Failed to admit to meeting", error);
    }
    return NextResponse.json(
      providerOutage
        ? { error: "Video is temporarily unavailable. Please try again." }
        : { error: "Could not join this meeting. Please try again." },
      { status: providerOutage ? 503 : 500 },
    );
  }
}
