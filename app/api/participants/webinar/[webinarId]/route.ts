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
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(participantReadLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { webinarId } = await params;
    const webinarEvent = await prisma.webinar.findFirst({
      where: {
        id: webinarId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              webinarPlan: {
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
        webinarPlan: {
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

    if (!webinarEvent) {
      return new NextResponse("Webinar not found", { status: 404 });
    }

    const participants = Array.from(
      new Map(
        webinarEvent.appointment?.participants.map((participant) => [
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
      webinarEvent.appointment ? [webinarEvent.appointment.id] : [],
      participants.map((u) => u.id),
    );

    return NextResponse.json({
      webinarEvent,
      participants,
      collaborators: webinarEvent.webinarPlan.collaborators,
      seatPayments,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[WEBINAR_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { webinarId } = await params;

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

    const webinarEvent = await prisma.webinar.findFirst({
      where: {
        id: webinarId,
        ...(isSelfLeave || isPrivileged(session.user.role)
          ? {}
          : {
              webinarPlan: {
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

    if (!webinarEvent) {
      return new NextResponse("Webinar not found", { status: 404 });
    }

    // #1005 — belt-and-braces with the attendee refund tier. Even if
    // computeRefundPct returned 0% after start, we still refuse the roster
    // mutation so "Leave event" cannot be used as a post-session cleanup that
    // looks like a successful leave. Organiser removals (moderation) skip this.
    if (isSelfLeave) {
      // Single contiguous event: once the first live atom has started, leave
      // is closed (unlike class, which keys on the last session — see class
      // DELETE).
      const earliestLive = await findLiveEventSlot(
        { webinarId },
        { order: "asc" },
      );
      if (earliestLive && earliestLive.startsAt.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: "Cannot leave an event that has already started." },
          { status: 400 },
        );
      }
    }

    // #1780 — the leave rule (window, host move, class quote) runs inside the
    // seat release's Serializable transaction; a refusal leaves the seat.
    let left;
    try {
      left = await leaveEventSeat({
        kind: "webinar",
        eventId: webinarId,
        userId,
        actorUserId: session.user.id,
        isSelfLeave,
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
      "webinar",
      webinarId,
      userId,
    );
    if (!channelRemoval.success) {
      console.warn(
        JSON.stringify({
          event: "attendee_channel_removal_failed",
          eventType: "webinar",
          eventId: webinarId,
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
    console.error("[WEBINAR_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
