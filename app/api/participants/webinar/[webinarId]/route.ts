import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
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

  if (!isPrivileged(session.user.role) && !session.user.consultantProfileId) {
    return forbiddenResponse("Only consultants can remove participants");
  }

  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { webinarId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Ownership check only — the old shape loaded the entire roster
    // (every slot × every full User row) just to find the one participant
    // being removed.
    const webinarEvent = await prisma.webinar.findFirst({
      where: {
        id: webinarId,
        ...(isPrivileged(session.user.role)
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

    // Only the slots this user actually occupies.
    const userSlots = await prisma.slotOfAppointment.findMany({
      where: {
        appointment: { webinarId },
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

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[WEBINAR_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
