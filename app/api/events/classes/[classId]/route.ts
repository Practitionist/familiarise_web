import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { classId: string } }
) {
  try {
    const { classId } = params;
    const classData = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: {
        classPlan: true,
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

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Class not found" },
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
  { params }: { params: { classId: string } }
) {
  try {
    const { classId } = params;
    const body = await request.json();

    const classData = await prisma.class.update({
      where: { id: classId },
      data: {
        startDate: body.startDate,
        endDate: body.endDate,
        status: body.status,
        tentativeStartDate: body.tentativeStartDate,
        tentativeSchedule: body.tentativeSchedule,
        currentParticipants: body.currentParticipants,
        recordingUrls: body.recordingUrls,
        feedbackSummary: body.feedbackSummary,
      },
      include: {
        classPlan: true,
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

    return NextResponse.json({ data: classData }, { status: 200 });
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
  { params }: { params: { classId: string } }
) {
  try {
    const { classId } = params;

    const classData = await prisma.class.delete({
      where: { id: classId },
      include: {
        classPlan: true,
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

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
