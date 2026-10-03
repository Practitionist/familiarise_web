import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

async function recordSynchronousJoinAttendance(args: {
  meetingId?: string;
  appointmentId?: string;
  userId: string;
}) {
  if (!args.meetingId) return;
  const now = new Date();

  try {
    let appointmentOccurrenceId = args.meetingId;
    if (prisma.meeting?.findUnique) {
      const row = await prisma.meeting.findUnique({
        where: { id: args.meetingId },
        select: { appointmentOccurrenceId: true },
      });
      if (row?.appointmentOccurrenceId) {
        appointmentOccurrenceId = row.appointmentOccurrenceId;
      }
    }

    if (prisma.meetingAttendance?.upsert) {
      await prisma.meetingAttendance.upsert({
        where: {
          meetingId_userId: {
            meetingId: args.meetingId,
            userId: args.userId,
          },
        },
        create: {
          meetingId: args.meetingId,
          appointmentOccurrenceId,
          userId: args.userId,
          firstJoinedAt: now,
          joinCount: 1,
        },
        update: {
          joinCount: { increment: 1 },
        },
      });
    }

    if (prisma.meetingPresence?.findFirst && prisma.meetingPresence?.create) {
      const openPresence = await prisma.meetingPresence.findFirst({
        where: {
          meetingId: args.meetingId,
          userId: args.userId,
          leftAt: null,
        },
        select: { id: true },
      });
      if (!openPresence) {
        await prisma.meetingPresence.create({
          data: {
            meetingId: args.meetingId,
            appointmentOccurrenceId,
            userId: args.userId,
            userSessionId: `join:${args.meetingId}:${args.userId}`,
            joinedAt: now,
          },
        });
      }
    }

    if (args.appointmentId && prisma.appointmentParticipant?.updateMany) {
      await prisma.appointmentParticipant.updateMany({
        where: {
          appointmentId: args.appointmentId,
          userId: args.userId,
          status: { in: ["HELD", "CONFIRMED"] },
        },
        data: { status: "ATTENDED" },
      });
    }
  } catch (err) {
    streamLogger.warn("Non-fatal failure recording synchronous join presence", {
      meetingId: args.meetingId,
      userId: args.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /api/meetings/[meetingId]/join
 * Verifies meeting access and DPDP consent, upserts the caller on Stream, grants
 * `call_member` membership, and stamps synchronous attendance.
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

    const role = "call_member";
    const resolvedCallId = toCallId(access.streamCallId ?? meetingId);

    await withStreamCircuitBreaker(async () => {
      await upsertUsersToStream([userId]);

      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        resolvedCallId,
      );

      await call.getOrCreate({ data: { created_by_id: userId } });

      await call.updateCallMembers({
        update_members: [{ user_id: userId, role }],
      });
    });

    await recordSynchronousJoinAttendance({
      meetingId: access.meetingId,
      appointmentId: access.appointment?.id,
      userId,
    });

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
