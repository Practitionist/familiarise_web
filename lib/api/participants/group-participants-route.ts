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
import { removeAttendeeForConduct } from "@/lib/booking/conduct-removal";
import { ConductRemovalBodySchema } from "@/schemas/conduct-removal";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { isRefusal } from "@/lib/errors/refusal";
import { recordRefundNeedsSupport } from "@/lib/payments/operations/refund-owed";
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
    const appointmentId = loaded.appointment?.id;
    const [seatPayments, waitingCount] = await Promise.all([
      readSeatPayments(
        appointmentId ? [appointmentId] : [],
        participants.map((u) => u.id),
      ),
      // A count only: the host never sees who is waiting.
      appointmentId
        ? prisma.appointmentWaitlist.count({
            where: { appointmentId, status: { in: ["WAITING", "NOTIFIED"] } },
          })
        : Promise.resolve(0),
    ]);

    return NextResponse.json({
      [loaded.key]: loaded.event,
      participants,
      collaborators: loaded.collaborators,
      seatPayments,
      waitingCount,
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

async function executeGroupSeatLeave(opts: {
  kind: GroupEventKind;
  eventId: string;
  userId: string;
  actorUserId: string;
  isSelfLeave: boolean;
  exitMode: boolean;
}) {
  if (opts.kind === "webinar") {
    return leaveEventSeat({
      kind: "webinar",
      eventId: opts.eventId,
      userId: opts.userId,
      actorUserId: opts.actorUserId,
      isSelfLeave: opts.isSelfLeave,
    });
  }
  return leaveEventSeat({
    kind: "class",
    eventId: opts.eventId,
    userId: opts.userId,
    actorUserId: opts.actorUserId,
    isSelfLeave: opts.isSelfLeave,
    exit: opts.isSelfLeave && opts.exitMode,
  });
}

/**
 * Who may remove an attendee for conduct: staff, the plan owner, an org
 * operator who may already remove attendees, or an accepted presenter-tier
 * co-host. Crew collaborators and attendees may not.
 */
async function canRemoveForConduct(
  session: Session,
  appointmentId: string,
): Promise<boolean> {
  const profileId = session.user.consultantProfileId ?? null;
  const planSelect = {
    consultantProfileId: true,
    organizationId: true,
    collaborators: {
      where: {
        consultantProfileId: profileId ?? "__none__",
        status: "ACCEPTED" as const,
        tier: "PRESENTER" as const,
        consultantProfile: { deletedAt: null },
      },
      select: { id: true },
    },
  };
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, deletedAt: null },
    select: {
      webinar: { select: { webinarPlan: { select: planSelect } } },
      class: { select: { classPlan: { select: planSelect } } },
    },
  });
  const plan =
    appointment?.webinar?.webinarPlan ?? appointment?.class?.classPlan;
  if (!plan) return false;
  if (isPrivileged(session.user.role)) return true;
  if (profileId && plan.consultantProfileId === profileId) return true;
  if (plan.collaborators.length > 0) return true;
  if (!plan.organizationId) return false;
  const membership = await prisma.membership.findFirst({
    where: {
      userId: session.user.id,
      organizationId: plan.organizationId,
      status: "ACTIVE",
      organization: { status: { not: "DEACTIVATED" } },
    },
    select: { role: true },
  });
  return (
    !!membership &&
    (hasOrgPermission(membership.role, "catalog.manage") ||
      hasOrgPermission(membership.role, "appointments.actForOrg.cancel"))
  );
}

/**
 * Removes an attendee from the appointment's webinar or class for conduct
 * (`lib/booking/conduct-removal.ts`): the seat ends now and support reviews it.
 */
export async function handleConductRemoval(
  request: Request,
  session: Session,
  appointmentId: string,
): Promise<NextResponse> {
  try {
    const parsed = ConductRemovalBodySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid removal request.", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const { targetUserId, reason, note } = parsed.data;
    if (targetUserId === session.user.id) {
      return NextResponse.json(
        { error: "You cannot remove yourself. Leave the session instead." },
        { status: 400 },
      );
    }
    if (!(await canRemoveForConduct(session, appointmentId))) {
      return forbiddenResponse(
        "Only the host or a co-host can remove attendees",
      );
    }
    const removed = await removeAttendeeForConduct({
      appointmentId,
      targetUserId,
      actorUserId: session.user.id,
      reason,
      note,
    }).catch((error: unknown) => {
      if (error instanceof BookingRuleError) return error;
      throw error;
    });
    if (removed instanceof BookingRuleError)
      return bookingRuleResponse(removed);
    if (!removed) return NextResponse.json({ removed: false });
    return NextResponse.json({
      removed: true,
      caseReference: removed.caseReference,
      earningsHeld: removed.earningsHeld,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CONDUCT_REMOVAL]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

/** POST /api/participants/{webinar|class}/[eventId]/remove — the roster's and the event chat's door. */
export async function handleGroupConductRemoval(
  request: Request,
  kind: GroupEventKind,
  eventId: string,
): Promise<NextResponse> {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;
  const appointment = await prisma.appointment.findFirst({
    where: kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
    select: { id: true },
  });
  if (!appointment) {
    return new NextResponse(
      kind === "webinar" ? "Webinar not found" : "Class not found",
      { status: 404 },
    );
  }
  return handleConductRemoval(request, session, appointment.id);
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

    const left = await executeGroupSeatLeave({
      kind,
      eventId,
      userId,
      actorUserId: session.user.id,
      isSelfLeave,
      exitMode: searchParams.get("mode") === "exit",
    }).catch((error: unknown) => {
      if (error instanceof BookingRuleError || isRefusal(error)) return error;
      throw error;
    });
    if (left instanceof BookingRuleError) return bookingRuleResponse(left);
    // Another door's refund still owed on the seat: nothing was released.
    if (isRefusal(left)) {
      await recordRefundNeedsSupport(left);
      return NextResponse.json(
        { error: left.userMessage, code: left.code },
        { status: left.httpStatus },
      );
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
