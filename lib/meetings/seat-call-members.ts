import prisma from "@/lib/prisma";
import {
  getStreamVideoClient,
  streamErrorCode,
  streamHttpStatus,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { CALL_MEMBER_ROLE, STREAM_CALL_TYPE } from "@/lib/stream/call-cid";
import { assertValidUpdateCallMembers } from "@/lib/stream/video-contracts";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Adds confirmed webinar or class attendees to the Stream calls already provisioned for the
 * appointment, so their join skips the membership write. Best effort and post-commit: a missing
 * call is fine because the join route adds any member the call lacks. The caller fences the grants.
 */
export async function addSeatHoldersToOpenCalls(
  appointmentId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const meetings = await prisma.meeting.findMany({
    where: {
      endedAt: null,
      occurrence: { appointmentId, deletedAt: null },
    },
    select: { streamCallId: true },
  });
  if (meetings.length === 0) return;

  const memberPayload = {
    update_members: userIds.map((user_id) => ({
      user_id,
      role: CALL_MEMBER_ROLE,
    })),
  };
  assertValidUpdateCallMembers(memberPayload);

  const results = await Promise.allSettled(
    meetings.map(({ streamCallId }) =>
      withStreamCircuitBreaker(() =>
        getStreamVideoClient()
          .video.call(STREAM_CALL_TYPE, streamCallId)
          .updateCallMembers(memberPayload),
      ),
    ),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" &&
      !(
        streamHttpStatus(result.reason) === 404 &&
        streamErrorCode(result.reason) === 16
      ),
  );
  if (failures.length > 0) {
    reportSentryError(failures[0].reason, {
      subsystem: "stream",
      op: "seatCallMembers",
      extra: { appointmentId, failed: failures.length },
    });
  }
}
