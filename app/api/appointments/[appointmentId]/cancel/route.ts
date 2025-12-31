import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { CancellationReason } from "@prisma/client";

interface CancelRequestBody {
  reason?: CancellationReason;
  notes?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;

    // Parse optional request body for cancellation reason
    let body: CancelRequestBody = {};
    try {
      const text = await request.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch {
      // Body parsing is optional - continue without it
    }

    // Validate cancellation reason if provided
    if (
      body.reason &&
      !Object.values(CancellationReason).includes(body.reason)
    ) {
      return NextResponse.json(
        { error: "Invalid cancellation reason" },
        { status: 400 }
      );
    }

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get appointment details
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: true,
          subscription: true,
          webinar: true,
          class: true,
        },
      });

      if (!appointment) {
        throw new Error("Appointment not found");
      }

      // Prepare cancellation data
      const cancellationData = {
        requestStatus: "CANCELLED" as const,
        cancellationReason: body.reason || null,
        cancellationNotes: body.notes || null,
        cancelledAt: new Date(),
        cancelledBy: session.user.id,
      };

      // Update appointment status based on type
      if (appointment.consultation) {
        await tx.consultation.update({
          where: { id: appointment.consultation.id },
          data: cancellationData,
        });
      } else if (appointment.subscription) {
        await tx.subscription.update({
          where: { id: appointment.subscription.id },
          data: cancellationData,
        });
      } else if (appointment.webinar) {
        await tx.webinar.update({
          where: { id: appointment.webinar.id },
          data: { status: "CANCELLED" },
        });
      } else if (appointment.class) {
        await tx.class.update({
          where: { id: appointment.class.id },
          data: { status: "CANCELLED" },
        });
      }

      // Delete slots
      await tx.slotOfAppointment.deleteMany({
        where: { appointmentId },
      });

      // Delete appointment
      await tx.appointment.delete({
        where: { id: appointmentId },
      });

      return {
        success: true,
        cancellationReason: body.reason,
        cancelledAt: cancellationData.cancelledAt,
      };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error canceling appointment:", error);

    if (error instanceof Error && error.message === "Appointment not found") {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 }
    );
  }
}
