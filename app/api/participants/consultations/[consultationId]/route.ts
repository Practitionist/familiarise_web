import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;
    const consultation = await prisma.consultation.findUnique({
      where: {
        id: consultationId,
      },
      include: {
        consultationPlan: true,
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!consultation) {
      return new NextResponse("Consultation not found", { status: 404 });
    }

    // For consultations, participants include the consultant and consultee
    const participants = [];

    // Add the consultee who requested the consultation
    if (consultation.requestedBy.user) {
      participants.push(consultation.requestedBy.user);
    }

    // Add any users from appointment slots (typically the consultant)
    if (consultation.appointment) {
      const slotUsers =
        consultation.appointment.slotsOfAppointment?.flatMap(
          (slot) => slot.user || [],
        ) || [];

      // Get unique participants by user ID (avoid duplicates)
      const uniqueUsers = Array.from(
        new Map(
          [...participants, ...slotUsers].map((user) => [user.id, user]),
        ).values(),
      );

      return NextResponse.json({
        consultation,
        participants: uniqueUsers,
      });
    }

    return NextResponse.json({
      consultation,
      participants,
    });
  } catch (error) {
    console.error("[CONSULTATION_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Find the consultation
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
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

    if (!consultation) {
      return new NextResponse("Consultation not found", { status: 404 });
    }

    // Remove user from all slots in the appointment
    if (consultation.appointment) {
      for (const slot of consultation.appointment.slotsOfAppointment) {
        if (slot.user.some((user) => user.id === userId)) {
          await prisma.slotOfAppointment.update({
            where: { id: slot.id },
            data: {
              user: {
                disconnect: { id: userId },
              },
            },
          });
        }
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[CONSULTATION_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
