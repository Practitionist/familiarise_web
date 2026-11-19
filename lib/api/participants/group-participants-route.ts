import { NextResponse } from "next/server";
import { reportSentryError } from "@/lib/observability/report";
import { z } from "zod";
import type { Session } from "@/lib/auth";
import prisma, { type PrismaLike } from "@/lib/prisma";
import {
  liveParticipant,
  RELEASED_PARTICIPANT_STATUSES,
} from "@/lib/booking/participants";
import { readSeatTrails, type SeatTrailStep } from "@/lib/booking/seat-history";
import { lastRemovalKind } from "@/lib/booking/seat-trail-copy";
import type { PlanRef } from "@/lib/collaborators/team";
import {
  activeOrgRole,
  resolveCollaborationViewer,
  seesAttendeePayments,
} from "@/lib/collaborators/viewer";
import { readSeatPayments } from "@/lib/data/seat-payments";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { leaveEventSeat } from "@/lib/booking/seat-leave";
import { removeAttendeeForConduct } from "@/lib/booking/conduct-removal";
import { liftSeatRemovalAsOrganiser } from "@/lib/booking/seat-removal-lift";
import {
  SeatLiftBodySchema,
  SeatLiftResponseSchema,
} from "@/schemas/seat-removal-lift";
import { ConductRemovalBodySchema } from "@/schemas/conduct-removal";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { bookingRuleResponse } from "@/lib/booking/booking-rule-response";
import { isRefusal } from "@/lib/errors/refusal";
import { recordRefundNeedsSupport } from "@/lib/payments/operations/refund-owed";
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
import {
  managedAsNamedExpertWhere,
  orgPlanEditRefusal,
} from "@/lib/enterprise/membership-guards";

export type GroupEventKind = "webinar" | "class";

const EVENT_ID = z.string().trim().min(1).max(64);

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
        id: true,
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
      // The plan's own expert, on an organisation's plan only while its active expert.
      ...(session.user.consultantProfileId
        ? [managedAsNamedExpertWhere(session.user.consultantProfileId)]
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
          id: string;
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
          participantId: participant.id,
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
      planRef: {
        planType: "webinar",
        planId: webinarEvent.webinarPlanId,
      } satisfies PlanRef,
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
    planRef: {
      planType: "class",
      planId: classEvent.classPlanId,
    } satisfies PlanRef,
  };
}

/** Seats an organiser or a conduct removal ended that still block a rejoin. */
function readRemovedSeats(appointmentId: string) {
  return prisma.appointmentParticipant.findMany({
    where: {
      appointmentId,
      role: "CONSULTEE",
      removedByUserId: { not: null },
      status: { in: RELEASED_PARTICIPANT_STATUSES },
    },
    select: { id: true, user: { select: PARTICIPANT_USER_SELECT } },
    orderBy: { updatedAt: "desc" },
  });
}

/** A removed attendee row: who, how they were last removed, and their trail. */
function removedAttendee(
  seat: Awaited<ReturnType<typeof readRemovedSeats>>[number],
  seatTrail: SeatTrailStep[],
) {
  return { ...seat.user, removal: lastRemovalKind(seatTrail), seatTrail };
}

async function readsAttendeePayments(
  planRef: PlanRef,
  userId: string,
): Promise<boolean> {
  const { viewer, plan } = await resolveCollaborationViewer(
    prisma,
    planRef,
    userId,
  );
  if (seesAttendeePayments(viewer)) return true;
  return seesAttendeePayments(
    viewer,
    await activeOrgRole(prisma, plan?.organizationId ?? null, userId),
  );
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
    // Everyone the gate above admitted reads the roster; what an attendee
    // paid goes to platform staff and to whoever `seesAttendeePayments` names.
    const sendsPayments =
      isPrivileged(session.user.role) ||
      (await readsAttendeePayments(loaded.planRef, session.user.id));
    const [seatPayments, waitingCount, removedSeats] = await Promise.all([
      sendsPayments
        ? readSeatPayments(
            appointmentId ? [appointmentId] : [],
            participants.map((u) => u.id),
          )
        : null,
      // A count only: the host never sees who is waiting.
      appointmentId
        ? prisma.appointmentWaitlist.count({
            where: { appointmentId, status: { in: ["WAITING", "NOTIFIED"] } },
          })
        : Promise.resolve(0),
      appointmentId ? readRemovedSeats(appointmentId) : Promise.resolve([]),
    ]);
    const trails = await readSeatTrails(prisma, [
      ...participants.map((p) => p.participantId),
      ...removedSeats.map((seat) => seat.id),
    ]);

    return NextResponse.json({
      [loaded.key]: loaded.event,
      participants: participants.map(({ participantId, ...p }) => ({
        ...p,
        seatTrail: trails.get(participantId) ?? [],
      })),
      removedAttendees: removedSeats.map((seat) =>
        removedAttendee(seat, trails.get(seat.id) ?? []),
      ),
      collaborators: loaded.collaborators,
      ...(seatPayments && { seatPayments }),
      waitingCount,
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "bookings",
      op: `${kind}-participants.read`,
    });
    return new NextResponse("Internal error", { status: 500 });
  }
}

/** Platform staff act through the organiser's doors unless `staffBypass` is off; the allow-back door turns it off. */
async function canOrganiserRemoveParticipant(
  session: Session,
  { staffBypass = true }: { staffBypass?: boolean } = {},
): Promise<boolean> {
  if (
    (staffBypass && isPrivileged(session.user.role)) ||
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
  { staffBypass = true }: { staffBypass?: boolean } = {},
): Promise<boolean> {
  const planAccess =
    isSelfLeave || (staffBypass && isPrivileged(session.user.role))
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

/** Staff, the plan owner, an org operator who may remove attendees, or an accepted presenter co-host. */
async function canRemoveForConduct(
  session: Session,
  appointmentId: string,
  db: PrismaLike = prisma,
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
  const appointment = await db.appointment.findFirst({
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
  if (
    profileId &&
    plan.consultantProfileId === profileId &&
    !(await orgPlanEditRefusal(db, plan, profileId))
  ) {
    return true;
  }
  if (plan.collaborators.length > 0) return true;
  if (!plan.organizationId) return false;
  const membership = await db.membership.findFirst({
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
        { error: "Choose a reason, and say why when the reason is Other." },
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
      authorizeTx: (tx) => canRemoveForConduct(session, appointmentId, tx),
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
    // The reporter logs the fault line and flushes before the function freezes.
    reportSentryError(error, { subsystem: "bookings", op: "conduct-removal" });
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
  const parsedEventId = EVENT_ID.safeParse(eventId);
  if (!parsedEventId.success) {
    return NextResponse.json(
      { error: "Event ID is required" },
      { status: 400 },
    );
  }
  const appointment = await prisma.appointment.findFirst({
    where:
      kind === "webinar"
        ? { webinarId: parsedEventId.data }
        : { classId: parsedEventId.data },
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

/** The leave's own durable revoker ends the seat's chat and call access after its commit. */
export async function handleGroupParticipantDelete(
  request: Request,
  kind: GroupEventKind,
  eventId: string,
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

    return NextResponse.json({ removed: true, refund: left.refund });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "bookings",
      op: `${kind}-participants.remove`,
    });
    return new NextResponse("Internal error", { status: 500 });
  }
}

/**
 * POST /api/participants/{webinar|class}/[eventId]/allow-back — the roster's
 * "Allow back" for an attendee the organiser removed. A conduct removal that
 * stands is refused here; support lifts it.
 */
export async function handleGroupSeatLift(
  request: Request,
  kind: GroupEventKind,
  eventId: string,
): Promise<NextResponse> {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;
  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;
  try {
    const parsedEventId = EVENT_ID.safeParse(eventId);
    const body = SeatLiftBodySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsedEventId.success || !body.success) {
      return NextResponse.json(
        { error: "Choose the attendee to allow back.", code: "INVALID_BODY" },
        { status: 400 },
      );
    }
    // Staff lift through the step-up staff door, which keeps the audit row.
    const organiserOnly = { staffBypass: false };
    if (!(await canOrganiserRemoveParticipant(session, organiserOnly))) {
      return forbiddenResponse("Only the organiser can allow attendees back");
    }
    const exists = await verifyGroupEventExistsForDelete(
      kind,
      parsedEventId.data,
      session,
      false,
      organiserOnly,
    );
    const appointment = exists
      ? await prisma.appointment.findFirst({
          where:
            kind === "webinar"
              ? { webinarId: parsedEventId.data }
              : { classId: parsedEventId.data },
          select: { id: true },
        })
      : null;
    if (!appointment) {
      return new NextResponse(
        kind === "webinar" ? "Webinar not found" : "Class not found",
        { status: 404 },
      );
    }
    const lifted = await liftSeatRemovalAsOrganiser({
      appointmentId: appointment.id,
      userId: body.data.userId,
      actorUserId: session.user.id,
    }).catch((error: unknown) => {
      if (error instanceof BookingRuleError) return error;
      throw error;
    });
    if (lifted instanceof BookingRuleError) return bookingRuleResponse(lifted);
    return NextResponse.json(
      SeatLiftResponseSchema.parse({
        lifted: true,
        rejoinPath: lifted.rejoinPath,
        conduct: lifted.conduct,
      }),
    );
  } catch (error) {
    reportSentryError(error, { subsystem: "bookings", op: "seat-lift" });
    return new NextResponse("Internal error", { status: 500 });
  }
}
