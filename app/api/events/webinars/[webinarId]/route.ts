import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const webinarData = await prisma.webinar.findUniqueOrThrow({
      where: { id: webinarId },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: true,
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
        waitlist: true,
        meetingRoom: {
          include: {
            recordings: true,
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
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }
    console.error("Error fetching webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the webinar" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const body = await request.json();

    const webinarData = await prisma.webinar.update({
      where: { id: webinarId },
      data: {
        status: body.status,
        feedbackSummary: body.feedbackSummary,
        webinarPlan: body.webinarPlanId
          ? {
              connect: { id: body.webinarPlanId },
            }
          : undefined,
        appointment: body.appointmentId
          ? {
              connect: { id: body.appointmentId },
            }
          : undefined,
      },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: true,
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
        waitlist: true,
        meetingRoom: {
          include: {
            recordings: true,
          },
        },
      },
    });

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    console.error("Error updating webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the webinar" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;

    const webinarData = await prisma.webinar.delete({
      where: { id: webinarId },
      include: {
        webinarPlan: {
          include: {
            topics: true,
            consultantProfile: true,
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
        waitlist: true,
        meetingRoom: {
          include: {
            recordings: true,
          },
        },
      },
    });

    return NextResponse.json({ data: webinarData }, { status: 200 });
  } catch (error) {
    console.error("Error deleting webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the webinar" },
      { status: 500 },
    );
  }
}
