import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { readSeatPayments } from "@/lib/data/seat-payments";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { leaveEventSeat } from "@/lib/booking/seat-leave";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { removeUserFromEventChannel } from "@/actions/stream/chat/event-channel.action";
import { findLiveEventSlot } from "@/lib/appointments/live-event-slot";
import {
  applyRateLimit,
  eventMutationLimiter,
  participantReadLimiter,
} from "@/lib/rate-limit";
import {
  hasOrgPermission,
  rolesWithOrgPermission,
} from "@/lib/auth/org-permissions";

export type GroupEventKind = "webinar" | "class";

const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

const COLLABORATORS_INCLUDE = {
  where: {
    status: "ACCEPTED" as const,
    consultantProfile: { deletedAt: null },
  },
  select: {
    id: true,
    role: true,
    tier: true,
    consultantProfile: {
      select: {
        id: true,
        user: { select: PARTICIPANT_USER_SELECT },
      },
    },
  },
  orderBy: { createdAt: "asc" as const },
} as const;

const APPOINTMENT_PARTICIPANTS_SELECT = {
  select: {
    id: true,
    participants: {
      where: { ...liveParticipant(), role: "CONSULTEE" as const },
      select: {
        status: true,
        role: true,
        user: { select: PARTICIPANT_USER_SELECT },
      },
    },
  },
} as const;

function buildPlanAccessClauses(
  session: Session,
  orgPermissions: (
    "catalog.manage" | "operations.read" | "appointments.actForOrg.cancel"
  )[],
  includePresenterCollaborator: boolean,
) {
  const allowedOrgRoles = orgPermissions.flatMap((perm) =>
    rolesWithOrgPermission(perm),
  );
  return {
    OR: [
      ...(session.user.consultantProfileId
        ? [{ consultantProfileId: session.user.consultantProfileId }]
        : []),
      {
        organization: {
          status: { not: "DEACTIVATED" as const },
          memberships: {
            some: {
              userId: session.user.id,
              status: "ACTIVE" as const,
              role: { in: allowedOrgRoles },
            },
          },
        },
      },
      ...(includePresenterCollaborator
        ? [
            {
              collaborators: {
                some: {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                  status: "ACCEPTED" as const,
                  tier: "PRESENTER" as const,
                  consultantProfile: { deletedAt: null },
                },
              },
            },
          ]
        : []),
    ],
  };
}

function deduplicateParticipants(
  appointment:
    | {
        id: string;
        participants: {
          status: string;
          role: string;
          user: {
            id: string;
            name: string | null;
            email: string;
            image: string | null;
          };
        }[];
      }
    | null
    | undefined,
) {
  return Array.from(
    new Map(
      appointment?.participants.map((participant) => [
        participant.user.id,
        {
          ...participant.user,
          participantStatus: participant.status,
          participantRole: participant.role,
        },
      ]) ?? [],
    ).values(),
  );
}

async function queryGroupEventForRead(
  kind: GroupEventKind,
  eventId: string,
  session: Session,
) {
  const planAccess = isPrivileged(session.user.role)
    ? undefined
    : buildPlanAccessClauses(
        session,
        ["catalog.manage", "operations.read"],
        true,
      );

  if (kind === "webinar") {
    const webinarEvent = await prisma.webinar.findFirst({
      where: {
        id: eventId,
        ...(planAccess ? { webinarPlan: planAccess } : {}),
      },
      include: {
        webinarPlan: { include: { collaborators: COLLABORATORS_INCLUDE } },
        appointment: APPOINTMENT_PARTICIPANTS_SELECT,
      },
    });
    if (!webinarEvent) return null;
    return {
      key: "webinarEvent" as const,
      event: webinarEvent,
      appointment: webinarEvent.appointment,
      collaborators: webinarEvent.webinarPlan.collaborators,
    };
  }

  const classEvent = await prisma.class.findFirst({
    where: {
      id: eventId,
      ...(planAccess ? { classPlan: planAccess } : {}),
    },
    include: {
      classPlan: { include: { collaborators: COLLABORATORS_INCLUDE } },
      appointment: APPOINTMENT_PARTICIPANTS_SELECT,
    },
  });
  if (!classEvent) return null;
  return {
    key: "classEvent" as const,
    event: classEvent,
    appointment: classEvent.appointment,
    collaborators: classEvent.classPlan.collaborators,
  };
}

export async function handleGroupParticipantsGet(
  _request: Request,
  kind: GroupEventKind,
  eventId: string,
): Promise<NextResponse> {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(participantReadLimiter, session.user.id);
  if (rl) return rl;

  try {
    const loaded = await queryGroupEventForRead(kind, eventId, session);
    if (!loaded) {
      const notFoundMsg =
        kind === "webinar" ? "Webinar not found" : "Class not found";
      return new NextResponse(notFoundMsg, { status: 404 });
    }

    const participants = deduplicateParticipants(loaded.appointment);
    const seatPayments = await readSeatPayments(
      loaded.appointment ? [loaded.appointment.id] : [],
      participants.map((u) => u.id),
    );

    return NextResponse.json({
      [loaded.key]: loaded.event,
      participants,
      collaborators: loaded.collaborators,
      seatPayments,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    const logLabel =
      kind === "webinar"
        ? "[WEBINAR_PARTICIPANTS_GET]"
        : "[CLASS_PARTICIPANTS_GET]";
    console.error(logLabel, error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

async function canOrganiserRemoveParticipant(
  session: Session,
): Promise<boolean> {
  if (
    isPrivileged(session.user.role) ||
    Boolean(session.user.consultantProfileId)
  ) {
    return true;
  }
  const memberships = await prisma.membership.findMany({
    where: {
      userId: session.user.id,
      status: "ACTIVE",
      organization: { status: { not: "DEACTIVATED" } },
    },
    select: { role: true },
  });
  return memberships.some(
    (m) =>
      hasOrgPermission(m.role, "catalog.manage") ||
      hasOrgPermission(m.role, "appointments.actForOrg.cancel"),
  );
}

async function verifyGroupEventExistsForDelete(
  kind: GroupEventKind,
  eventId: string,
  session: Session,
  isSelfLeave: boolean,
): Promise<boolean> {
  const planAccess =
    isSelfLeave || isPrivileged(session.user.role)
      ? undefined
      : buildPlanAccessClauses(
          session,
          ["catalog.manage", "appointments.actForOrg.cancel"],
          false,
        );

  if (kind === "webinar") {
    const found = await prisma.webinar.findFirst({
      where: {
        id: eventId,
        ...(planAccess ? { webinarPlan: planAccess } : {}),
      },
      select: { id: true },
    });
    return Boolean(found);
  }

  const found = await prisma.class.findFirst({
    where: {
      id: eventId,
      ...(planAccess ? { classPlan: planAccess } : {}),
    },
    select: { id: true },
  });
  return Boolean(found);
}

async function checkSelfLeaveWindow(
  kind: GroupEventKind,
  eventId: string,
): Promise<NextResponse | null> {
  if (kind === "webinar") {
    const earliestLive = await findLiveEventSlot(
      { webinarId: eventId },
      { order: "asc" },
    );
    if (earliestLive && earliestLive.startsAt.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "Cannot leave an event that has already started." },
        { status: 400 },
      );
    }
    return null;
  }

  const lastLive = await findLiveEventSlot(
    { classId: eventId },
    { order: "desc" },
  );
  if (lastLive && lastLive.startsAt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Cannot leave a class after its last session has started." },
      { status: 400 },
    );
  }
  return null;
}

export async function handleGroupParticipantDelete(
  request: Request,
  kind: GroupEventKind,
  eventId: string,
  removeFromChannel: (userId: string) => Promise<{ success: boolean }> = (
    userId,
  ) => removeUserFromEventChannel(kind, eventId, userId),
): Promise<NextResponse> {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { searchParams } = new URL(request.url);
    const parsedUserId = z
      .string()
      .trim()
      .min(1)
      .max(64)
      .safeParse(searchParams.get("userId"));
    if (!parsedUserId.success) {
      return new NextResponse("User ID is required", { status: 400 });
    }
    const userId = parsedUserId.data;

    const isSelfLeave = userId === session.user.id;
    if (!isSelfLeave && !(await canOrganiserRemoveParticipant(session))) {
      return forbiddenResponse(
        "Only consultants can remove other participants",
      );
    }

    const exists = await verifyGroupEventExistsForDelete(
      kind,
      eventId,
      session,
      isSelfLeave,
    );
    if (!exists) {
      const notFoundMsg =
        kind === "webinar" ? "Webinar not found" : "Class not found";
      return new NextResponse(notFoundMsg, { status: 404 });
    }

    if (isSelfLeave) {
      const windowRefusal = await checkSelfLeaveWindow(kind, eventId);
      if (windowRefusal) return windowRefusal;
    }

    let left;
    try {
      left =
        kind === "webinar"
          ? await leaveEventSeat({
              kind: "webinar",
              eventId,
              userId,
              actorUserId: session.user.id,
              isSelfLeave,
            })
          : await leaveEventSeat({
              kind: "class",
              eventId,
              userId,
              actorUserId: session.user.id,
              isSelfLeave,
              exit: isSelfLeave && searchParams.get("mode") === "exit",
            });
    } catch (error) {
      if (error instanceof BookingRuleError) return bookingRuleResponse(error);
      throw error;
    }

    if (!left) {
      return NextResponse.json({ removed: false, refund: null });
    }

    const channelRemoval = await removeFromChannel(userId);
    if (!channelRemoval.success) {
      console.warn(
        JSON.stringify({
          event: "attendee_channel_removal_failed",
          eventType: kind,
          eventId,
          userId,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return NextResponse.json({ removed: true, refund: left.refund });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    const logLabel =
      kind === "webinar"
        ? "[WEBINAR_PARTICIPANT_DELETE]"
        : "[CLASS_PARTICIPANT_DELETE]";
    console.error(logLabel, error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
