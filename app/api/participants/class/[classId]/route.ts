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
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(participantReadLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { classId } = await params;
    // Non-privileged users can view the roster if they own the plan OR are an
    // accepted collaborator granted canSeeAttendees (#768). Everyone else 404s.
    const classEvent = await prisma.class.findFirst({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
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
        classPlan: true,
        appointments: {
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

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // Get unique participants by user ID
    const participants = Array.from(
      new Map(
        classEvent.appointments
          ?.flatMap(
            (appointment) =>
              appointment.slotsOfAppointment?.flatMap(
                (slot) => slot.user || [],
              ) || [],
          )
          .map((user) => [user.id, user]) || [],
      ).values(),
    );

    return NextResponse.json({
      classEvent,
      participants,
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

  if (!isPrivileged(session.user.role) && !session.user.consultantProfileId) {
    return forbiddenResponse("Only consultants can remove participants");
  }

  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { classId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Ownership check only — the old shape loaded the entire roster
    // (every appointment × every slot × every full User row) just to find
    // the one participant being removed.
    const classEvent = await prisma.class.findFirst({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      select: { id: true },
    });

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // Only the slots this user actually occupies.
    const userSlots = await prisma.slotOfAppointment.findMany({
      where: {
        appointment: { classId },
        user: { some: { id: userId } },
      },
      select: { id: true },
    });

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

    // #1003 — the seat was paid for. Removing the attendee without returning
    // the fee let the organiser keep money for a session they just barred the
    // buyer from. Post-commit and non-throwing: the removal stands either way.
    const refund = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: classId,
      attendeeUserId: userId,
      initiatedByUserId: session.user.id,
    });

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
