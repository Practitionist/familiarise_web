import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
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

const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(participantReadLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { classId } = await params;
    const classEvent = await prisma.class.findFirst({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                OR: [
                  ...(session.user.consultantProfileId
                    ? [
                        {
                          consultantProfileId: session.user.consultantProfileId,
                        },
                      ]
                    : []),
                  {
                    organization: {
                      status: { not: "DEACTIVATED" },
                      memberships: {
                        some: {
                          userId: session.user.id,
                          status: "ACTIVE",
                          role: {
                            in: [
                              ...rolesWithOrgPermission("catalog.manage"),
                              ...rolesWithOrgPermission("operations.read"),
                            ],
                          },
                        },
                      },
                    },
                  },
                  {
                    collaborators: {
                      some: {
                        consultantProfileId:
                          session.user.consultantProfileId ?? "__none__",
                        status: "ACCEPTED",
                        tier: "PRESENTER",
                        consultantProfile: { deletedAt: null },
                      },
                    },
                  },
                ],
              },
            }),
      },
      include: {
        classPlan: {
          include: {
            collaborators: {
              where: {
                status: "ACCEPTED",
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
              orderBy: { createdAt: "asc" },
            },
          },
        },
        appointment: {
          select: {
            id: true,
            participants: {
              where: { ...liveParticipant(), role: "CONSULTEE" },
              select: {
                status: true,
                role: true,
                user: { select: PARTICIPANT_USER_SELECT },
              },
            },
          },
        },
      },
    });

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    const participants = Array.from(
      new Map(
        classEvent.appointment?.participants.map((participant) => [
          participant.user.id,
          {
            ...participant.user,
            participantStatus: participant.status,
            participantRole: participant.role,
          },
        ]) || [],
      ).values(),
    );

    const seatPayments = await readSeatPayments(
      classEvent.appointment ? [classEvent.appointment.id] : [],
      participants.map((u) => u.id),
    );

    return NextResponse.json({
      classEvent,
      participants,
      collaborators: classEvent.classPlan.collaborators,
      seatPayments,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CLASS_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { classId } = await params;

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
    let isOrganiser =
      isPrivileged(session.user.role) || !!session.user.consultantProfileId;
    if (!isSelfLeave && !isOrganiser) {
      const memberships = await prisma.membership.findMany({
        where: {
          userId: session.user.id,
          status: "ACTIVE",
          organization: { status: { not: "DEACTIVATED" } },
        },
        select: { role: true },
      });
      isOrganiser = memberships.some(
        (m) =>
          hasOrgPermission(m.role, "catalog.manage") ||
          hasOrgPermission(m.role, "appointments.actForOrg.cancel"),
      );
    }
    if (!isSelfLeave && !isOrganiser) {
      return forbiddenResponse(
        "Only consultants can remove other participants",
      );
    }

    const classEvent = await prisma.class.findFirst({
      where: {
        id: classId,
        ...(isSelfLeave || isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                OR: [
                  ...(session.user.consultantProfileId
                    ? [
                        {
                          consultantProfileId: session.user.consultantProfileId,
                        },
                      ]
                    : []),
                  {
                    organization: {
                      status: { not: "DEACTIVATED" },
                      memberships: {
                        some: {
                          userId: session.user.id,
                          status: "ACTIVE",
                          role: {
                            in: [
                              ...rolesWithOrgPermission("catalog.manage"),
                              ...rolesWithOrgPermission(
                                "appointments.actForOrg.cancel",
                              ),
                            ],
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
      },
      select: { id: true },
    });

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // #1005 — class self-leave is allowed between sessions until the *last*
    // live session has started. Webinar DELETE correctly keys on the earliest
    // atom (one contiguous event); a months-long class keeps past sessions as
    // COMPLETED/UNVERIFIED which are still "live" for run math, so an earliest
    // gate permanently 400s after week 1 while the UI still offers Leave.
    // Organiser removals keep working mid/post session for moderation.
    if (isSelfLeave) {
      const lastLive = await findLiveEventSlot({ classId }, { order: "desc" });
      if (lastLive && lastLive.startsAt.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: "Cannot leave a class after its last session has started." },
          { status: 400 },
        );
      }
    }

    // #1780 — the leave rule (window, host move, class quote) runs inside the
    // seat release's Serializable transaction; a refusal leaves the seat.
    let left;
    try {
      left = await leaveEventSeat({
        kind: "class",
        eventId: classId,
        userId,
        actorUserId: session.user.id,
        isSelfLeave,
        // #1780 E-5 — `?mode=exit`: the learner's own full-refund exit right.
        exit: isSelfLeave && searchParams.get("mode") === "exit",
      });
    } catch (error) {
      if (error instanceof BookingRuleError) return bookingRuleResponse(error);
      throw error;
    }

    // 200, not 404: DELETE is idempotent and "off the roster" is the end state.
    if (!left) {
      return NextResponse.json({ removed: false, refund: null });
    }
    const { refund } = left;

    // #1169 PR 4 — a removed/refunded attendee must not keep reading the event
    // chat until the nightly expiry job notices. Non-throwing by contract.
    const channelRemoval = await removeUserFromEventChannel(
      "class",
      classId,
      userId,
    );
    if (!channelRemoval.success) {
      console.warn(
        JSON.stringify({
          event: "attendee_channel_removal_failed",
          eventType: "class",
          eventId: classId,
          userId,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return NextResponse.json({ removed: true, refund });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CLASS_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
