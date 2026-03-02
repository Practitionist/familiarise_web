import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { webinarId } = await params;
    // Non-privileged users can only view participants for webinars they own as consultant
    const webinarEvent = await prisma.webinar.findUnique({
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
      include: {
        webinarPlan: true,
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
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

    // Get waitlist entries with user details
    const waitlist = await prisma.waitlist.findMany({
      where: {
        webinarId: webinarId,
        status: {
          in: ["WAITING", "NOTIFIED", "EXPIRED"],
        },
      },
      include: {
        user: true,
      },
      orderBy: {
        joinedAt: "asc",
      },
    });

    return NextResponse.json({
      webinarEvent,
      participants,
      waitlist,
    });
  } catch (error) {
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

  try {
    const { webinarId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Remove user from all slots in the appointment
    // Non-privileged users can only modify webinars they own as consultant
    const webinarEvent = await prisma.webinar.findUnique({
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
      include: {
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    if (!webinarEvent) {
      return new NextResponse("Webinar not found", { status: 404 });
    }

    // Disconnect user from all slots they are in
    let participantRemoved = false;
    if (webinarEvent.appointment) {
      for (const slot of webinarEvent.appointment.slotsOfAppointment) {
        if (slot.user.some((user) => user.id === userId)) {
          await prisma.slotOfAppointment.update({
            where: { id: slot.id },
            data: {
              user: {
                disconnect: { id: userId },
              },
            },
          });
          participantRemoved = true;
        }
      }
    }

    // Trigger waitlist notification if a participant was removed
    if (participantRemoved) {
      try {
        await handleSlotOpening({ webinarId, slotsAvailable: 1 });
      } catch (error) {
        // Log error but don't fail the request - participant removal succeeded
        console.error("[WEBINAR_WAITLIST_NOTIFICATION]", error);
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[WEBINAR_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
