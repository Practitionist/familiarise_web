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
        appointment: {
          include: {
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
                slotOfAvailabilityWeekly: true,
                slotOfAvailabilityCustom: true,
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
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
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
        consultationPlan: {
          connect: { id: body.consultationPlanId },
        },
        appointment: {
          update: {
            slotOfAppointment: {
              connect: { id: body.slotOfAppointmentId },
            },
          },
        },
      },
      include: {
        consultationPlan: true,
        appointment: {
          include: {
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
                slotOfAvailabilityWeekly: true,
                slotOfAvailabilityCustom: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
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
        appointment: {
          include: {
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
                slotOfAvailabilityWeekly: true,
                slotOfAvailabilityCustom: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
