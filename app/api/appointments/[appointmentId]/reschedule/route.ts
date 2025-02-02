import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";

export async function POST(
  request: NextRequest,
  { params }: { params: { appointmentId: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = params;

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get appointment details
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          slotsOfAppointment: true,
          consultation: true,
          subscription: true,
          webinar: true,
          class: true,
        },
      });

      if (!appointment) {
        throw new Error("Appointment not found");
      }

      // Update all slots to tentative
      await tx.slotOfAppointment.updateMany({
        where: { appointmentId },
        data: { isTentative: true },
      });

      // Update status based on appointment type
      if (appointment.consultation) {
        await tx.consultation.update({
          where: { id: appointment.consultation.id },
          data: { requestStatus: "PENDING" },
        });
      } else if (appointment.subscription) {
        await tx.subscription.update({
          where: { id: appointment.subscription.id },
          data: { requestStatus: "PENDING" },
        });
      } else if (appointment.webinar) {
        await tx.webinar.update({
          where: { id: appointment.webinar.id },
          data: { status: "SCHEDULED" },
        });
      } else if (appointment.class) {
        await tx.class.update({
          where: { id: appointment.class.id },
          data: { status: "SCHEDULED" },
        });
      }

      return { success: true };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error requesting reschedule:", error);
    return NextResponse.json(
      { error: "Failed to request reschedule" },
      { status: 500 },
    );
  }
}
