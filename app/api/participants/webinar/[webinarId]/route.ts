import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  liveParticipant,
  releaseParticipant,
} from "@/lib/booking/participants";
import { readSeatPayments } from "@/lib/data/seat-payments";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
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

    return NextResponse.json(
      {
        webinarEvent,
        participants,
        seatPayments,
      },
      { headers: NO_STORE_HEADERS },
    );
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

    // #1003 — nothing to remove means nothing to refund. The refund helper
    // looks the payment up by user + event rather than by what was actually
    // released, so a removal that released nothing still raised an ops page.
    //
    // The roster read used to sit OUTSIDE the write, which made that guard
    // decorative under concurrency: a repeat click, a stale tab, or an
    // organiser removing someone who is leaving at the same moment both read a
    // non-empty roster and both went on to refund one paid seat twice.
    // Re-reading inside a Serializable transaction makes the seat itself the
    // arbiter — the loser is aborted on the row it also tried to write, and its
    // retry sees the empty roster.
    const removedSeats = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // #1554 — the participant row IS the seat. The live-status CAS in the
          // WHERE makes the loser of a concurrent removal match zero rows, so
          // a `removed: false` answer never refunds a seat twice.
          return releaseParticipant(tx, {
            appointment: { webinarId },
            userId,
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          // One CAS statement now, but the house budget stays matched to the
          // sibling handler so the two removals keep one contract.
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );

    // 200, not 404: DELETE is idempotent and "this person is off the roster"
    // is the requested end state either way. A 404 made the second click read
    // as a failure to the roster client, which throws on any non-ok response —
    // so it showed "Failed to remove participant" and never invalidated the
    // query, leaving the removed row on screen.
    if (removedSeats === 0) {
      return NextResponse.json({ removed: false, refund: null });
    }

    // #1003 — seat was paid; refund after roster commit (non-throwing).
    // #1005 — must pass initiatedBy: self-leave used to inherit organiser-fault
    // 100% because the helper defaulted isConsultantInitiated=true.
    const refund = await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: webinarId,
      attendeeUserId: userId,
      initiatedByUserId: session.user.id,
      initiatedBy: isSelfLeave ? "attendee" : "organiser",
    });

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
