import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { NOT_COLLABORATOR_ROW } from "@/lib/booking/participants";
import { guardMeetingRoute } from "@/lib/meetings/route-guard";
import {
  MAX_MEETING_EXTENSIONS,
  MEETING_EXTENSION_SECONDS,
  resolveRoomCapSeconds,
  resolveRoomEndsAt,
  roomTimeCustom,
} from "@/lib/meetings/duration-cap";
import {
  buildCallSettingsOverride,
  participantLimitsFromStream,
} from "@/lib/meetings/room-ready";
import { meetingControlLimiter } from "@/lib/rate-limit";
import {
  getStreamVideoClient,
  StreamUnavailableError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { reportSentryError } from "@/lib/observability/report";
import { getPlatformVideoConfig } from "@/lib/stream/video-config";
import {
  hostBatchEntries,
  HostTimeNotRetainedError,
  withHostSlotBatch,
} from "@/lib/booking/host-slot-batch";
import {
  buildCohostCommitmentFilter,
  buildDeadHoldFilter,
  OCCUPYING_OCCURRENCE_WHERE,
  buildOccupiedAppointmentFilter,
} from "@/utils/scheduling-engine/occupancyPolicy";
import {
  assertConsultantAvailableForWindows,
  ConsultantScheduleConflictError,
} from "@/lib/collaborators/availability";

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
      deletedAt: null,
      participants: {
        some: {
          userId: { in: participantUserIds },
          status: {
            in: ["HELD", "CONFIRMED", "ATTENDED"] as (
              "HELD" | "CONFIRMED" | "ATTENDED"
            )[],
          },
          ...NOT_COLLABORATOR_ROW,
        },
      },
    },
  };
  const consultantClauses = consultantProfileId
    ? [
        { consultantProfileId, appointment: { deletedAt: null } },
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

/** Checked against the room end; the overlap EXCLUDE index sees only booked ends, never extensions. */
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
        // Live holds and pending requests count, as for every reader; a lapsed hold does not.
        ...OCCUPYING_OCCURRENCE_WHERE,
        NOT: { appointment: buildDeadHoldFilter(new Date()) },
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

/** Fields a room can only be extended through: unended, unclassified, still scheduled. */
function extendableWhere(meetingId: string, extensionsUsed: number) {
  return {
    id: meetingId,
    endedAt: null,
    extensionsUsed: { equals: extensionsUsed, lt: MAX_MEETING_EXTENSIONS },
    occurrence: {
      completionStatus: "SCHEDULED" as const,
      outcome: null,
      deletedAt: null,
    },
  };
}

/**
 * Brings the Stream call up to the Postgres extension; every value is derived, so a retry
 * converges instead of adding time. Returns whether Stream was behind.
 */
async function mirrorExtensionToStream(args: {
  streamCallId: string;
  appointmentType: string | null;
  startsAt: Date;
  bookedEndsAt: Date;
  extendedSeconds: number;
  extensionsUsed: number;
}): Promise<{ wrote: boolean; capSeconds: number }> {
  return withStreamCircuitBreaker(async () => {
    const call = getStreamVideoClient().video.call(
      STREAM_CALL_TYPE,
      toCallId(args.streamCallId),
    );
    let current: Awaited<ReturnType<typeof call.get>>;
    try {
      current = await call.get();
    } catch (err) {
      throw err instanceof StreamUnavailableError
        ? err
        : new StreamUnavailableError();
    }
    if (!current?.call) throw new StreamUnavailableError();

    const existingCap = current.call.settings?.limits?.max_duration_seconds;
    const derivedCap = resolveRoomCapSeconds(
      args.startsAt,
      args.bookedEndsAt,
      args.extendedSeconds,
    );
    const capSeconds =
      typeof existingCap === "number" && existingCap > derivedCap
        ? existingCap
        : derivedCap;
    const existingCustom: Record<string, unknown> = current.call.custom ?? {};
    const timeCustom = roomTimeCustom(args);
    const inSync =
      existingCap === capSeconds &&
      existingCustom.extensionsUsed === timeCustom.extensionsUsed &&
      existingCustom.extendedSeconds === timeCustom.extendedSeconds;
    if (inSync) return { wrote: false, capSeconds };

    await call.update({
      settings_override: buildCallSettingsOverride(
        args.appointmentType,
        capSeconds,
        participantLimitsFromStream(current.call.settings?.limits),
        await getPlatformVideoConfig(),
      ),
      custom: { ...existingCustom, ...timeCustom },
    });
    return { wrote: true, capSeconds };
  });
}

function extendedBody(args: {
  capSeconds: number;
  extensionsUsed: number;
  roomEndsAt: Date;
}) {
  return {
    extended: true,
    addedSeconds: MEETING_EXTENSION_SECONDS,
    maxDurationSeconds: args.capSeconds,
    extensionsUsed: args.extensionsUsed,
    endsAt: args.roomEndsAt.toISOString(),
    hasConflictingNextBooking: false,
  };
}

const alreadyExtendedResponse = (roomEndsAt: Date) =>
  NextResponse.json(
    {
      extended: false,
      alreadyExtended: true,
      endsAt: roomEndsAt.toISOString(),
      hasConflictingNextBooking: false,
      error: "Free +15m extension has already been used for this session.",
    },
    { status: 409 },
  );

const nextTimeBookedResponse = () =>
  NextResponse.json(
    {
      extended: false,
      hasConflictingNextBooking: true,
      code: "SESSION_NOT_EXTENDABLE",
      error:
        "The time right after this session is booked, so it can't be extended.",
    },
    { status: 409 },
  );

const timeNotRetainedResponse = () =>
  NextResponse.json(
    {
      extended: false,
      hasConflictingNextBooking: false,
      code: "SESSION_NOT_EXTENDABLE",
      error:
        "The extra time couldn't be reserved just now. Please try again in a moment.",
    },
    { status: 409 },
  );

const notExtendableResponse = () =>
  NextResponse.json(
    {
      extended: false,
      code: "SESSION_NOT_EXTENDABLE",
      error: "This session has ended and can no longer be extended.",
    },
    { status: 409 },
  );

/**
 * POST /api/meetings/[meetingId]/extend
 * Grants the host one free 15-minute room extension when nothing is booked into it. The booked
 * `endsAt` never moves; the extension lives on `Meeting` and Stream mirrors it.
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
      meetingControlLimiter,
    );
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
        streamCallId: true,
        endedAt: true,
        extendedSeconds: true,
        extensionsUsed: true,
        occurrence: {
          select: {
            id: true,
            appointmentId: true,
            startsAt: true,
            endsAt: true,
            completionStatus: true,
            outcome: true,
            deletedAt: true,
            consultantProfileId: true,
            appointment: {
              select: {
                participants: {
                  where: {
                    status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
                    ...NOT_COLLABORATOR_ROW,
                  },
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
    if (
      meetingRow.endedAt ||
      occurrence.deletedAt ||
      occurrence.completionStatus !== "SCHEDULED" ||
      occurrence.outcome !== null
    ) {
      return notExtendableResponse();
    }

    const appt = access.appointment;
    const appointmentType = resolveAppointmentType(appt);
    const startsAt = new Date(occurrence.startsAt);
    const bookedEndsAt = new Date(occurrence.endsAt);
    const mirrorArgs = {
      streamCallId: meetingRow.streamCallId,
      appointmentType,
      startsAt,
      bookedEndsAt,
    };

    if (meetingRow.extensionsUsed >= MAX_MEETING_EXTENSIONS) {
      // A retry after a failed Stream write lands here and finishes the mirror.
      const mirrored = await mirrorExtensionToStream({
        ...mirrorArgs,
        extendedSeconds: meetingRow.extendedSeconds,
        extensionsUsed: meetingRow.extensionsUsed,
      });
      const roomEndsAt = resolveRoomEndsAt(
        bookedEndsAt,
        meetingRow.extendedSeconds,
      );
      if (!mirrored.wrote) return alreadyExtendedResponse(roomEndsAt);
      return NextResponse.json(
        extendedBody({
          capSeconds: mirrored.capSeconds,
          extensionsUsed: meetingRow.extensionsUsed,
          roomEndsAt,
        }),
      );
    }

    const consultantProfileId = resolveHostProfileId(
      occurrence.consultantProfileId,
      appt,
    );
    const isGroupCohort = Boolean(
      occurrence.appointment?.webinar || occurrence.appointment?.class,
    );
    const participantUserIds = isGroupCohort
      ? []
      : (occurrence.appointment?.participants ?? [])
          .map((p) => p.userId)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );

    const currentRoomEndsAt = resolveRoomEndsAt(
      bookedEndsAt,
      meetingRow.extendedSeconds,
    );
    const conflictHorizon = new Date(
      Math.max(currentRoomEndsAt.getTime(), Date.now()) +
        MEETING_EXTENSION_SECONDS * 1000,
    );

    // The +15 minutes are host time: hold their atoms (host and presenters)
    // across the probe and the claim, so no booking lands in them meanwhile.
    const presenterProfileIds = (
      occurrence.appointment?.webinar?.webinarPlan?.collaborators ??
      occurrence.appointment?.class?.classPlan?.collaborators ??
      []
    ).map((c) => c.consultantProfileId);
    const extensionWindow = {
      startsAt: new Date(Math.max(currentRoomEndsAt.getTime(), Date.now())),
      endsAt: conflictHorizon,
    };
    let refusal: NextResponse | null;
    try {
      refusal = await withHostSlotBatch(
        hostBatchEntries(
          consultantProfileId
            ? [consultantProfileId, ...presenterProfileIds]
            : presenterProfileIds,
          [extensionWindow],
        ),
        async (_renew, retainUntil) => {
          const conflicted = await hasExtensionScheduleConflict(
            occurrence,
            consultantProfileId,
            participantUserIds,
            startsAt,
            conflictHorizon,
          );
          if (conflicted) return nextTimeBookedResponse();

          // No occurrence row carries the extra minutes, so their atoms must be
          // held to the room's new end before the extension is saved.
          const keep = await retainUntil(conflictHorizon);

          const claimed = await prisma.meeting.updateMany({
            where: extendableWhere(meetingRow.id, meetingRow.extensionsUsed),
            data: {
              extendedSeconds: { increment: MEETING_EXTENSION_SECONDS },
              extensionsUsed: { increment: 1 },
            },
          });
          if (claimed.count === 0) {
            const latest = await prisma.meeting.findUnique({
              where: { id: meetingRow.id },
              select: { extensionsUsed: true, extendedSeconds: true },
            });
            return latest && latest.extensionsUsed >= MAX_MEETING_EXTENSIONS
              ? alreadyExtendedResponse(
                  resolveRoomEndsAt(bookedEndsAt, latest.extendedSeconds),
                )
              : notExtendableResponse();
          }

          keep();
          return null;
        },
      );
    } catch (err) {
      if (err instanceof HostTimeNotRetainedError) {
        return timeNotRetainedResponse();
      }
      if (err instanceof ConsultantScheduleConflictError) {
        return nextTimeBookedResponse();
      }
      throw err;
    }
    if (refusal) return refusal;

    const extendedSeconds =
      meetingRow.extendedSeconds + MEETING_EXTENSION_SECONDS;
    const extensionsUsed = meetingRow.extensionsUsed + 1;
    const roomEndsAt = resolveRoomEndsAt(bookedEndsAt, extendedSeconds);

    let capSeconds: number;
    try {
      ({ capSeconds } = await mirrorExtensionToStream({
        ...mirrorArgs,
        extendedSeconds,
        extensionsUsed,
      }));
    } catch (streamErr) {
      reportSentryError(streamErr, {
        subsystem: "stream",
        op: "meetings.extend.stream-failed",
        extra: { meetingId },
      });
      return NextResponse.json(
        {
          code: "EXTEND_SYNC_PENDING",
          error:
            "The extra 15 minutes are saved, but the video room has not picked them up yet. Please try again.",
        },
        { status: 503 },
      );
    }

    streamLogger.info("Meeting duration extended by host", {
      userId,
      meetingId: meetingRow.id,
      addedSeconds: MEETING_EXTENSION_SECONDS,
      maxDurationSeconds: capSeconds,
      extensionsUsed,
      roomEndsAt: roomEndsAt.toISOString(),
    });

    return NextResponse.json(
      extendedBody({ capSeconds, extensionsUsed, roomEndsAt }),
    );
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
