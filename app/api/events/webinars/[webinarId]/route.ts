import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { webinarId: string } }
) {
  try {
    const { webinarId } = params;
    const webinarData = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinarId },
      include: {
        webinarPlan: true,
        topics: true,
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

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar not found" },
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
  { params }: { params: { webinarId: string } }
) {
  try {
    const { webinarId } = params;
    const body = await request.json();

    const webinarData = await prisma.webinar.update({
      where: { id: webinarId },
      data: {
        title: body.title,
        description: body.description,
        price: body.price,
        scheduledAt: body.scheduledAt,
        durationInHours: body.durationInHours,
        webinarPlan: {
          connect: { id: body.webinarPlanId },
        },
        topics: {
          set: body.topicIds ? body.topicIds.map((id: string) => ({ id })) : [],
        },
        appointment: body.appointmentId ? {
          connect: { id: body.appointmentId },
        } : undefined,
      },
      include: {
        webinarPlan: true,
        topics: true,
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

    return NextResponse.json({ data: webinarData }, { status: 200 });
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
  { params }: { params: { webinarId: string } }
) {
  try {
    const { webinarId } = params;

    const webinarData = await prisma.webinar.delete({
      where: { id: webinarId },
      include: {
        webinarPlan: true,
        topics: true,
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

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}