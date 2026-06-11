import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";
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

// Bound the waitlist payload; the UI shows a roster, not an export. The
// truncated flag tells the client the count is a floor, not an exact size.
const WAITLIST_CAP = 500;

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
    // Non-privileged users can only view participants for classes they own as consultant
    const classEvent = await prisma.class.findUnique({
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

    // Get waitlist entries with user details
    const waitlist = await prisma.waitlist.findMany({
      where: {
        classId: classId,
        status: {
          in: ["WAITING", "NOTIFIED", "EXPIRED"],
        },
      },
      include: {
        user: { select: PARTICIPANT_USER_SELECT },
      },
      orderBy: {
        joinedAt: "asc",
      },
      take: WAITLIST_CAP,
    });

    return NextResponse.json({
      classEvent,
      participants,
      waitlist,
      waitlistTruncated: waitlist.length === WAITLIST_CAP,
    });
  } catch (error) {
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
    const classEvent = await prisma.class.findUnique({
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
    const participantRemoved = userSlots.length > 0;

    // Trigger waitlist notification if a participant was removed
    if (participantRemoved) {
      try {
        await handleSlotOpening({ classId, slotsAvailable: 1 });
      } catch (error) {
        // Log error but don't fail the request - participant removal succeeded
        console.error("[CLASS_WAITLIST_NOTIFICATION]", error);
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[CLASS_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
