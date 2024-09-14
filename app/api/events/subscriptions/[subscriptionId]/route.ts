import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;
    const subscriptionData = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
        plan: true,
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

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription not found" },
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
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;
    const body = await request.json();

    const subscriptionData = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        startDate: body.startDate,
        endDate: body.endDate,
        plan: {
          connect: { id: body.planId },
        },
        appointment: body.appointmentId ? {
          connect: { id: body.appointmentId },
        } : undefined,
      },
      include: {
        plan: true,
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

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
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
  { params }: { params: { subscriptionId: string } }
) {
  try {
    const { subscriptionId } = params;

    const subscriptionData = await prisma.subscription.delete({
      where: { id: subscriptionId },
      include: {
        plan: true,
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

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}