import { NextResponse } from "next/server"
import prisma from "@/lib/prisma";

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
    })

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 })
    }

    // Get unique participants by user ID
    const participants = Array.from(new Map(
      classEvent.appointments?.flatMap(
        appointment => 
          appointment.slotsOfAppointment?.flatMap(slot => slot.user || []) || []
      ).map(user => [user.id, user]) || []
    ).values())

    return NextResponse.json({
      classEvent,
      participants
    })
  } catch (error) {
    console.error("[CLASS_PARTICIPANTS_GET]", error)
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get("userId")

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 })
    }

    // Remove user from all slots in all appointments for this class
    const classEvent = await prisma.class.findUnique({
      where: { id: classId },
      include: {
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true
              }
            }
          }
        }
      }
    });

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // Disconnect user from all slots they are in
    for (const appointment of classEvent.appointments) {
      for (const slot of appointment.slotsOfAppointment) {
        if (slot.user.some(user => user.id === userId)) {
          await prisma.slotOfAppointment.update({
            where: { id: slot.id },
            data: {
              user: {
                disconnect: { id: userId }
              }
            }
          });
        }
      }
    }

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error("[CLASS_PARTICIPANT_DELETE]", error)
    return new NextResponse("Internal error", { status: 500 })
  }
}
