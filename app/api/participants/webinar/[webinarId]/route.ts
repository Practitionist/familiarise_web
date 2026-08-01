import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
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
    // accepted collaborator granted canSeeAttendees (#768). Everyone else 404s.
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
                        canSeeAttendees: true,
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
            slotsOfAppointment: {
              select: {
                id: true,
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

    // Get unique participants by user ID
    const participants = Array.from(
      new Map(
        webinarEvent.appointment?.slotsOfAppointment
          ?.flatMap((slot) => slot.user || [])
          .map((user) => [user.id, user]) || [],
      ).values(),
    );

    return NextResponse.json({
      webinarEvent,
      participants,
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
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // #1005 — consultees may remove themselves (self-leave). Organisers and
    // privileged roles may remove anyone on their event.
    const isSelfLeave = userId === session.user.id;
    const isOrganiser =
      isPrivileged(session.user.role) || !!session.user.consultantProfileId;
    if (!isSelfLeave && !isOrganiser) {
      return forbiddenResponse("Only consultants can remove other participants");
    }

    // Ownership check for organiser removals; self-leave only needs the event
    // to exist and the caller to be on the roster (checked via userSlots).
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
      const earliestLive = await prisma.slotOfAppointment.findFirst({
        where: {
          appointment: { webinarId },
          deletedAt: null,
          OR: [
            { completionStatus: null },
            { completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] } },
          ],
        },
        orderBy: { startsAt: "asc" },
        select: { startsAt: true },
      });
      if (earliestLive && earliestLive.startsAt.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: "Cannot leave an event that has already started." },
          { status: 400 },
        );
      }
    }

    // Only the slots this user actually occupies.
    const userSlots = await prisma.slotOfAppointment.findMany({
      where: {
        appointment: { webinarId },
        user: { some: { id: userId } },
      },
      select: { id: true },
    });

    // #1003 — nothing to remove means nothing to refund. Without this the
    // handler committed an empty transaction and still called the seat refund,
    // which looks the payment up by user + event rather than by what was
    // actually released — so repeat clicks and stale tabs each raised an ops
    // page for a removal that never happened.
    //
    // 200, not 404: DELETE is idempotent and "this person is off the roster"
    // is the requested end state either way. A 404 made the second click read
    // as a failure to the roster client, which throws on any non-ok response —
    // so it showed "Failed to remove participant" and never invalidated the
    // query, leaving the removed row on screen.
    if (userSlots.length === 0) {
      return NextResponse.json({ removed: false, refund: null });
    }

    // One atomic batch — sequential awaits paid a DB round trip per slot
    // and could partially remove a participant on mid-loop failure.
    await prisma.$transaction(
      userSlots.map((slot) =>
        prisma.slotOfAppointment.update({
          where: { id: slot.id },
          data: {
            user: {
              disconnect: { id: userId },
            },
          },
        }),
      ),
    );

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
