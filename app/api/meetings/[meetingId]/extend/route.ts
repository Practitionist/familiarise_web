import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  MAX_CALL_DURATION_MS,
  resolveMaxCallDurationSeconds,
} from "@/lib/meetings/duration-cap";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";

const EXTENSION_SECONDS = 15 * 60;
const EXTENSION_MS = EXTENSION_SECONDS * 1000;
const MAX_CALL_DURATION_SECONDS = Math.floor(MAX_CALL_DURATION_MS / 1000);

/**
 * POST /api/meetings/[meetingId]/extend
 * Grants a free 15-minute duration cap extension for the host when no conflicting booking starts within 15 minutes.
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

    if (access.role !== "host") {
      streamLogger.warn("Meeting extend refused — caller is not the host", {
        userId,
        meetingId,
        role: access.role,
      });
      return NextResponse.json(
        {
          error: "Only the host can extend this session.",
          reason: "not_host",
        },
        { status: 403 },
      );
    }

    const meetingRow = await prisma.meeting.findUnique({
      where: { id: access.meetingId },
      select: {
        id: true,
        occurrence: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            consultantProfileId: true,
          },
        },
      },
    });

    if (!meetingRow?.occurrence) {
      return NextResponse.json(
        { error: "Session occurrence not found." },
        { status: 404 },
      );
    }

    const { occurrence } = meetingRow;
    const appt = access.appointment;
    const consultantProfileId =
      occurrence.consultantProfileId ??
      appt?.consultation?.consultationPlan?.consultantProfileId ??
      appt?.subscription?.subscriptionPlan?.consultantProfileId ??
      appt?.webinar?.webinarPlan?.consultantProfileId ??
      appt?.class?.classPlan?.consultantProfileId ??
      appt?.trial?.consultantProfileId ??
      null;

    const now = new Date();
    const slotEndsAt = new Date(occurrence.endsAt);
    const slotStartsAt = new Date(occurrence.startsAt);
    const conflictHorizon = new Date(
      Math.max(slotEndsAt.getTime(), now.getTime()) + EXTENSION_MS,
    );

    if (consultantProfileId && prisma.appointmentOccurrence?.findFirst) {
      const conflictingOccurrence =
        await prisma.appointmentOccurrence.findFirst({
          where: {
            id: { not: occurrence.id },
            consultantProfileId,
            isTentative: false,
            deletedAt: null,
            completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
            startsAt: { lt: conflictHorizon },
            endsAt: { gt: slotStartsAt },
          },
          select: { id: true, startsAt: true },
        });

      if (conflictingOccurrence) {
        return NextResponse.json(
          {
            extended: false,
            hasConflictingNextBooking: true,
            error:
              "Cannot extend because another confirmed session starts within 15 minutes.",
          },
          { status: 409 },
        );
      }
    }

    const baseCapSeconds =
      resolveMaxCallDurationSeconds({ endsAt: slotEndsAt }, slotStartsAt) ??
      3600;
    const resolvedCallId = toCallId(access.streamCallId);

    const newMaxDurationSeconds = await withStreamCircuitBreaker(async () => {
      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        resolvedCallId,
      );
      let currentCapSeconds = baseCapSeconds;
      let existingCustom: Record<string, unknown> = {};

      if (typeof call.get === "function") {
        try {
          const currentState = await call.get();
          const existingCap =
            currentState?.call?.settings?.limits?.max_duration_seconds;
          if (typeof existingCap === "number" && existingCap > 0) {
            currentCapSeconds = Math.max(currentCapSeconds, existingCap);
          }
          if (
            currentState?.call?.custom &&
            typeof currentState.call.custom === "object"
          ) {
            existingCustom = currentState.call.custom as Record<
              string,
              unknown
            >;
          }
        } catch {
          // Proceed with baseCapSeconds if reading live call state fails.
        }
      }

      const updatedCapSeconds = Math.min(
        currentCapSeconds + EXTENSION_SECONDS,
        MAX_CALL_DURATION_SECONDS,
      );
      const prevExtended =
        typeof existingCustom.extendedSeconds === "number"
          ? existingCustom.extendedSeconds
          : 0;

      await call.update({
        settings_override: {
          limits: { max_duration_seconds: updatedCapSeconds },
        },
        custom: {
          ...existingCustom,
          extendedSeconds: prevExtended + EXTENSION_SECONDS,
        },
      });

      return updatedCapSeconds;
    });

    streamLogger.info("Meeting duration extended by host", {
      userId,
      meetingId: resolvedCallId,
      addedSeconds: EXTENSION_SECONDS,
      maxDurationSeconds: newMaxDurationSeconds,
    });

    return NextResponse.json({
      extended: true,
      addedSeconds: EXTENSION_SECONDS,
      maxDurationSeconds: newMaxDurationSeconds,
      hasConflictingNextBooking: false,
    });
  } catch (error) {
    if (error instanceof StreamUnavailableError) {
      streamLogger.warn("Meeting extend unavailable — Stream circuit open", {
        meetingId: meetingIdForLog,
      });
      return NextResponse.json(
        { error: "Video is temporarily unavailable. Please try again." },
        { status: 503 },
      );
    }

    reportSentryError(error, { subsystem: "stream", op: "meetings.extend" });
    streamLogger.error("Failed to extend meeting duration", error);
    return NextResponse.json(
      { error: "Could not extend this meeting. Please try again." },
      { status: 500 },
    );
  }
}
