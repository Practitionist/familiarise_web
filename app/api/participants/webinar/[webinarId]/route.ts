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

// Display fields only — the old `user: true` shipped every User scalar
// (role, verification state, timestamps…) for every participant on every
// poll of the roster page.
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
    // Non-privileged users can view the roster if they own the plan OR are an
    // accepted PRESENTER collaborator (#1580). Everyone else 404s.
    const webinarEvent = await prisma.webinar.findFirst({
      where: {
        id: webinarId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              webinarPlan: {
                OR: [
                  {
                    consultantProfileId:
                      session.user.consultantProfileId ?? "__none__",
                  },
                  {
                    collaborators: {
                      some: {
                        consultantProfileId:
                          session.user.consultantProfileId ?? "__none__",
                        status: "ACCEPTED",
                        tier: "PRESENTER",
                      },
                    },
                  },
                ],
              },
            }),
      },
      include: {
        webinarPlan: true,
        appointment: {
          select: {
            id: true,
            participants: {
              where: liveParticipant(),
              select: { user: { select: PARTICIPANT_USER_SELECT } },
            },
          },
        },
      },
    });

    if (!webinarEvent) {
      return new NextResponse("Webinar not found", { status: 404 });
    }

    // Get unique participants by user ID
    const participants = Array.from(
      new Map(
        webinarEvent.appointment?.participants.map((participant) => [
          participant.user.id,
          participant.user,
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

    // #1005 — consultees may remove themselves (self-leave). Organisers and
    // privileged roles may remove anyone on their event.
    const isSelfLeave = userId === session.user.id;
    const isOrganiser =
      isPrivileged(session.user.role) || !!session.user.consultantProfileId;
    if (!isSelfLeave && !isOrganiser) {
      return forbiddenResponse(
        "Only consultants can remove other participants",
      );
    }

    // Ownership check for organiser removals; self-leave only needs the event
    // to exist and the caller to be on the roster (the seat release below matches zero rows otherwise).
    const webinarEvent = await prisma.webinar.findFirst({
      where: {
        id: webinarId,
        ...(isSelfLeave || isPrivileged(session.user.role)
          ? {}
          : {
              webinarPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
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
