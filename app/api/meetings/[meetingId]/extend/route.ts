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

function resolveExtensionsUsed(
  rawExtensionsUsed: unknown,
  prevExtended: number,
): number {
  if (typeof rawExtensionsUsed === "number") return rawExtensionsUsed;
  return prevExtended >= EXTENSION_SECONDS ? 1 : 0;
}

function buildConflictScope(
  consultantProfileId: string | null,
  participantUserIds: string[],
) {
  const participantClause = {
    appointment: {
      participants: {
        some: {
          userId: { in: participantUserIds },
          status: {
            in: ["HELD", "CONFIRMED", "ATTENDED"] as (
              "HELD" | "CONFIRMED" | "ATTENDED"
            )[],
          },
        },
      },
    },
  };
  if (consultantProfileId && participantUserIds.length > 0) {
    return { OR: [{ consultantProfileId }, participantClause] };
  }
  if (consultantProfileId) {
    return { consultantProfileId };
  }
  return participantClause;
}

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
            appointmentId: true,
            startsAt: true,
            endsAt: true,
            consultantProfileId: true,
            appointment: {
              select: {
                participants: {
                  where: { status: { in: ["HELD", "CONFIRMED", "ATTENDED"] } },
                  select: { userId: true },
                },
              },
            },
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
    const participantUserIds = (occurrence.appointment?.participants ?? [])
      .map((p) => p.userId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const now = new Date();
    const slotEndsAt = new Date(occurrence.endsAt);
    const slotStartsAt = new Date(occurrence.startsAt);
    const conflictHorizon = new Date(
      Math.max(slotEndsAt.getTime(), now.getTime()) + EXTENSION_MS,
    );

    if (consultantProfileId || participantUserIds.length > 0) {
      const conflictScope = buildConflictScope(
        consultantProfileId,
        participantUserIds,
      );

      const conflictingOccurrence =
        await prisma.appointmentOccurrence.findFirst({
          where: {
            id: { not: occurrence.id },
            ...conflictScope,
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

    const extendResult = await withStreamCircuitBreaker(async () => {
      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        resolvedCallId,
      );
      let currentState: Awaited<ReturnType<typeof call.get>>;
      try {
        currentState = await call.get();
      } catch (err) {
        throw err instanceof StreamUnavailableError
          ? err
          : new StreamUnavailableError();
      }

      if (!currentState?.call) {
        throw new StreamUnavailableError();
      }

      let currentCapSeconds = baseCapSeconds;
      const existingCap =
        currentState.call.settings?.limits?.max_duration_seconds;
      if (typeof existingCap === "number" && existingCap > 0) {
        currentCapSeconds = Math.max(currentCapSeconds, existingCap);
      }

      const existingCustom: Record<string, unknown> =
        currentState.call.custom && typeof currentState.call.custom === "object"
          ? (currentState.call.custom as Record<string, unknown>)
          : {};

      const prevExtended =
        typeof existingCustom.extendedSeconds === "number"
          ? existingCustom.extendedSeconds
          : 0;
      const extensionsUsed = resolveExtensionsUsed(
        existingCustom.extensionsUsed,
        prevExtended,
      );

      if (extensionsUsed >= 1) {
        return {
          alreadyExtended: true as const,
          updatedCapSeconds: currentCapSeconds,
          extensionsUsed,
        };
      }

      const updatedCapSeconds = Math.min(
        currentCapSeconds + EXTENSION_SECONDS,
        MAX_CALL_DURATION_SECONDS,
      );
      const nextExtensionsUsed = extensionsUsed + 1;

      await call.update({
        settings_override: {
          limits: { max_duration_seconds: updatedCapSeconds },
        },
        custom: {
          ...existingCustom,
          extendedSeconds: prevExtended + EXTENSION_SECONDS,
          extensionsUsed: nextExtensionsUsed,
        },
      });

      return {
        alreadyExtended: false as const,
        updatedCapSeconds,
        extensionsUsed: nextExtensionsUsed,
      };
    });

    if (extendResult.alreadyExtended) {
      return NextResponse.json(
        {
          extended: false,
          alreadyExtended: true,
          hasConflictingNextBooking: false,
          error: "Free +15m extension has already been used for this session.",
        },
        { status: 409 },
      );
    }

    streamLogger.info("Meeting duration extended by host", {
      userId,
      meetingId: resolvedCallId,
      addedSeconds: EXTENSION_SECONDS,
      maxDurationSeconds: extendResult.updatedCapSeconds,
      extensionsUsed: extendResult.extensionsUsed,
    });

    return NextResponse.json({
      extended: true,
      addedSeconds: EXTENSION_SECONDS,
      maxDurationSeconds: extendResult.updatedCapSeconds,
      extensionsUsed: extendResult.extensionsUsed,
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
