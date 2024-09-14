import prisma from "@/lib/prisma";
import { Prisma, PlanEmailSupport } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { classId: string } }
) {
  try {
    const { classId } = params;
    const classPlan = await prisma.classPlan.findUniqueOrThrow({
      where: { id: classId },
      include: {
        consultantProfile: true,
        classes: true,
      },
    });

    return NextResponse.json({ data: classPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Class plan not found" },
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

    if (body.emailSupport && !Object.values(PlanEmailSupport).includes(body.emailSupport)) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 }
      );
    }

    const classPlan = await prisma.classPlan.update({
      where: { id: classId },
      data: {
        durationInMonths: body.durationInMonths,
        price: body.price,
        callsPerWeek: body.callsPerWeek,
        videoMeetings: body.videoMeetings,
        emailSupport: body.emailSupport as PlanEmailSupport,
        consultantProfile: body.consultantProfileId ? {
          connect: { id: body.consultantProfileId },
        } : undefined,
        classes: body.classIds ? {
          set: body.classIds.map((id: string) => ({ id })),
        } : undefined,
      },
      include: {
        consultantProfile: true,
        classes: true,
      },
    });

    return NextResponse.json({ data: classPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Class plan not found" },
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

export async function DELETE(
  request: Request,
  { params }: { params: { classId: string } }
) {
  try {
    const { classId } = params;

    const classPlan = await prisma.classPlan.delete({
      where: { id: classId },
      include: {
        consultantProfile: true,
        classes: true,
      },
    });

    return NextResponse.json({ data: classPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Class plan not found" },
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