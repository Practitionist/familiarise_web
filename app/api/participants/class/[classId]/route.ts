import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    const classEvent = await prisma.class.findUnique({
      where: {
        id: classId,
      },
      include: {
        classPlan: true,
        appointments: {
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
        user: true,
      },
      orderBy: {
        joinedAt: "asc",
      },
    });

    return NextResponse.json({
      classEvent,
      participants,
      waitlist,
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
  try {
    const { classId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Remove user from all slots in all appointments for this class
    const classEvent = await prisma.class.findUnique({
      where: { id: classId },
      include: {
        appointments: {
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

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // Disconnect user from all slots they are in
    let participantRemoved = false;
    for (const appointment of classEvent.appointments) {
      for (const slot of appointment.slotsOfAppointment) {
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
