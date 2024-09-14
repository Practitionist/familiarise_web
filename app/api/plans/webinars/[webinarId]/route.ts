import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { webinarId: string } }
) {
  try {
    const { webinarId } = params;
    const webinarPlan = await prisma.webinarPlan.findUniqueOrThrow({
      where: { id: webinarId },
      include: {
        consultantProfile: true,
        webinars: true,
      },
    });

    return NextResponse.json({ data: webinarPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
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

    if (body.durationInHours && body.durationInHours <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 }
      );
    }

    const webinarPlan = await prisma.webinarPlan.update({
      where: { id: webinarId },
      data: {
        durationInHours: body.durationInHours,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        consultantProfile: body.consultantProfileId ? {
          connect: { id: body.consultantProfileId },
        } : undefined,
        webinars: body.webinarIds ? {
          set: body.webinarIds.map((id: string) => ({ id })),
        } : undefined,
      },
      include: {
        consultantProfile: true,
        webinars: true,
      },
    });

    return NextResponse.json({ data: webinarPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
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
  { params }: { params: { webinarId: string } }
) {
  try {
    const { webinarId } = params;

    const webinarPlan = await prisma.webinarPlan.delete({
      where: { id: webinarId },
      include: {
        consultantProfile: true,
        webinars: true,
      },
    });

    return NextResponse.json({ data: webinarPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
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