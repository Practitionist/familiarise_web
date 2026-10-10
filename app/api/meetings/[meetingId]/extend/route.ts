import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  MAX_CALL_DURATION_MS,
  resolveMaxCallDurationSeconds,
} from "@/lib/meetings/duration-cap";
import { buildCallSettingsOverride } from "@/lib/meetings/room-ready";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";
import {
  buildCohostCommitmentFilter,
  buildOccupiedAppointmentFilter,
} from "@/utils/scheduling-engine/occupancyPolicy";
import {
  assertConsultantAvailableForWindows,
  ConsultantScheduleConflictError,
} from "@/lib/collaborators/availability";

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

/**
 * Builds the Prisma `OR` clause matching any live occurrence that blocks a
 * session extension for the host (direct `consultantProfileId`, hosted plan,
 * or accepted co-host collaboration) or any active participant.
 */
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
  const consultantClauses = consultantProfileId
    ? [
        { consultantProfileId },
        {
          appointment: {
            deletedAt: null,
            OR: [
              ...buildOccupiedAppointmentFilter(consultantProfileId),
              ...buildCohostCommitmentFilter(consultantProfileId),
            ],
          },
        },
      ]
    : [];
  if (consultantClauses.length > 0 && participantUserIds.length > 0) {
    return { OR: [...consultantClauses, participantClause] };
  }
  if (consultantClauses.length > 0) {
    return { OR: consultantClauses };
  }
  return participantClause;
}

const PRESENTER_COLLABORATORS_SELECT = {
  where: {
    status: "ACCEPTED" as const,
    tier: "PRESENTER" as const,
    consultantProfile: { deletedAt: null },
  },
  select: {
    consultantProfileId: true,
    consultantProfile: { select: { userId: true } },
  },
};

type ExtendAccessShape = {
  meetingId: string;
  role: string;
  streamCallId: string;
  appointment?: {
    appointmentType?: string | null;
    consultation?: {
      consultationPlan?: { consultantProfileId?: string | null } | null;
    } | null;
    subscription?: {
      subscriptionPlan?: { consultantProfileId?: string | null } | null;
    } | null;
    webinar?: {
      webinarPlan?: { consultantProfileId?: string | null } | null;
    } | null;
    class?: {
      classPlan?: { consultantProfileId?: string | null } | null;
    } | null;
    trial?: { consultantProfileId?: string | null } | null;
  } | null;
};

function resolveHostProfileId(
  occurrenceConsultantProfileId: string | null,
  appt: ExtendAccessShape["appointment"],
): string | null {
  return (
    occurrenceConsultantProfileId ??
    appt?.consultation?.consultationPlan?.consultantProfileId ??
    appt?.subscription?.subscriptionPlan?.consultantProfileId ??
    appt?.webinar?.webinarPlan?.consultantProfileId ??
    appt?.class?.classPlan?.consultantProfileId ??
    appt?.trial?.consultantProfileId ??
    null
  );
}

function resolveAppointmentType(
  appt: ExtendAccessShape["appointment"],
): string | null {
  if (appt?.appointmentType) return appt.appointmentType;
  if (appt?.webinar) return "WEBINAR";
  if (appt?.class) return "CLASS";
  if (appt?.consultation) return "CONSULTATION";
  if (appt?.subscription) return "SUBSCRIPTION";
  if (appt?.trial) return "TRIAL";
  return null;
}

async function hasExtensionScheduleConflict(
  occurrence: {
    id: string;
    appointmentId: string;
    appointment?: {
      webinar?: {
        webinarPlan?: {
          collaborators?: {
            consultantProfileId: string;
            consultantProfile?: { userId?: string | null } | null;
          }[];
        } | null;
      } | null;
      class?: {
        classPlan?: {
          collaborators?: {
            consultantProfileId: string;
            consultantProfile?: { userId?: string | null } | null;
          }[];
        } | null;
      } | null;
    } | null;
  },
  consultantProfileId: string | null,
  participantUserIds: string[],
  slotStartsAt: Date,
  conflictHorizon: Date,
): Promise<boolean> {
  if (consultantProfileId || participantUserIds.length > 0) {
    const conflictScope = buildConflictScope(
      consultantProfileId,
      participantUserIds,
    );

    const conflictingOccurrence = await prisma.appointmentOccurrence.findFirst({
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

    if (conflictingOccurrence) return true;
  }

  const presenterCollaborators =
    occurrence.appointment?.webinar?.webinarPlan?.collaborators ??
    occurrence.appointment?.class?.classPlan?.collaborators ??
    [];
  for (const collab of presenterCollaborators) {
    try {
      await assertConsultantAvailableForWindows(prisma, {
        consultantProfileId: collab.consultantProfileId,
        consultantUserId: collab.consultantProfile?.userId ?? undefined,
        windows: [{ startsAt: slotStartsAt, endsAt: conflictHorizon }],
        excludeAppointmentIds: [occurrence.appointmentId],
      });
    } catch (err) {
      if (err instanceof ConsultantScheduleConflictError) return true;
      throw err;
    }
  }

  return false;
}

async function applyStreamCallExtension(
  resolvedCallId: string,
  baseCapSeconds: number,
  appointmentType: string | null,
): Promise<{
  alreadyExtended: boolean;
  updatedCapSeconds: number;
  extensionsUsed: number;
}> {
  return withStreamCircuitBreaker(async () => {
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
      typeof currentState.call.custom === "object" &&
      currentState.call.custom !== null
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
        alreadyExtended: true,
        updatedCapSeconds: currentCapSeconds,
        extensionsUsed,
      };
    }

    const updatedCapSeconds = Math.min(
      currentCapSeconds + EXTENSION_SECONDS,
      MAX_CALL_DURATION_SECONDS,
    );
    const nextExtensionsUsed = extensionsUsed + 1;
    const settingsOverride = buildCallSettingsOverride(
      appointmentType,
      updatedCapSeconds,
    ) ?? {
      limits: { max_duration_seconds: updatedCapSeconds },
    };

    await call.update({
      settings_override: settingsOverride,
      custom: {
        ...existingCustom,
        extendedSeconds: prevExtended + EXTENSION_SECONDS,
        extensionsUsed: nextExtensionsUsed,
      },
    });

    return {
      alreadyExtended: false,
      updatedCapSeconds,
      extensionsUsed: nextExtensionsUsed,
    };
  });
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
                webinar: {
                  select: {
                    webinarPlan: {
                      select: {
                        collaborators: PRESENTER_COLLABORATORS_SELECT,
                      },
                    },
                  },
                },
                class: {
                  select: {
                    classPlan: {
                      select: {
                        collaborators: PRESENTER_COLLABORATORS_SELECT,
                      },
                    },
                  },
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
    const consultantProfileId = resolveHostProfileId(
      occurrence.consultantProfileId,
      appt,
    );
    const participantUserIds = (occurrence.appointment?.participants ?? [])
      .map((p) => p.userId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const slotEndsAt = new Date(occurrence.endsAt);
    const slotStartsAt = new Date(occurrence.startsAt);
    const conflictHorizon = new Date(
      Math.max(slotEndsAt.getTime(), Date.now()) + EXTENSION_MS,
    );

    const conflicted = await hasExtensionScheduleConflict(
      occurrence,
      consultantProfileId,
      participantUserIds,
      slotStartsAt,
      conflictHorizon,
    );
    if (conflicted) {
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

    const baseCapSeconds =
      resolveMaxCallDurationSeconds({ endsAt: slotEndsAt }, slotStartsAt) ??
      3600;
    const resolvedCallId = toCallId(access.streamCallId);
    const extendResult = await applyStreamCallExtension(
      resolvedCallId,
      baseCapSeconds,
      resolveAppointmentType(appt),
    );

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

    const extendedEndsAt = new Date(slotEndsAt.getTime() + EXTENSION_MS);
    await prisma.appointmentOccurrence.updateMany({
      where: { id: occurrence.id, endsAt: slotEndsAt },
      data: { endsAt: extendedEndsAt },
    });

    streamLogger.info("Meeting duration extended by host", {
      userId,
      meetingId: resolvedCallId,
      addedSeconds: EXTENSION_SECONDS,
      maxDurationSeconds: extendResult.updatedCapSeconds,
      extensionsUsed: extendResult.extensionsUsed,
      extendedEndsAt: extendedEndsAt.toISOString(),
    });

    return NextResponse.json({
      extended: true,
      addedSeconds: EXTENSION_SECONDS,
      maxDurationSeconds: extendResult.updatedCapSeconds,
      extensionsUsed: extendResult.extensionsUsed,
      endsAt: extendedEndsAt.toISOString(),
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
