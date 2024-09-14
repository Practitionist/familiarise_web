import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const consultationPlan = await prisma.consultationPlan.findUniqueOrThrow({
      where: { id: consultationId },
      include: {
        consultantProfile: true,
        consultations: true,
      },
    });

    return NextResponse.json({ data: consultationPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
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

    if (body.durationInHours && body.durationInHours <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 }
      );
    }

    const consultationPlan = await prisma.consultationPlan.update({
      where: { id: consultationId },
      data: {
        durationInHours: body.durationInHours,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        consultantProfile: body.consultantProfileId ? {
          connect: { id: body.consultantProfileId },
        } : undefined,
      },
      include: {
        consultantProfile: true,
        consultations: true,
      },
    });

    return NextResponse.json({ data: consultationPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
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
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;

    const consultationPlan = await prisma.consultationPlan.delete({
      where: { id: consultationId },
      include: {
        consultantProfile: true,
        consultations: true,
      },
    });

    return NextResponse.json({ data: consultationPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
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
