import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
      include: {
        consultationPlan: true,
        requestedBy: true,
        appointment: {
          include: {
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }
    console.error("Error fetching consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const body = await request.json();

    const consultation = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        requestStatus: body.requestStatus,
        directlyBooked: body.directlyBooked,
        preferredDateTime: body.preferredDateTime,
        requestNotes: body.requestNotes,
        feedbackFromConsultee: body.feedbackFromConsultee,
        feedbackFromConsultant: body.feedbackFromConsultant,
        rating: body.rating,
        consultationPlan: body.consultationPlanId ? {
          connect: { id: body.consultationPlanId },
        } : undefined,
        appointment: body.appointmentId ? {
          connect: { id: body.appointmentId },
        } : undefined,
      },
      include: {
        consultationPlan: true,
        requestedBy: true,
        appointment: {
          include: {
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the consultation" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;

    const consultation = await prisma.consultation.delete({
      where: { id: consultationId },
      include: {
        consultationPlan: true,
        requestedBy: true,
        appointment: {
          include: {
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    console.error("Error deleting consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the consultation" },
      { status: 500 }
    );
  }
}
