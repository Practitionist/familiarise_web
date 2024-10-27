import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
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
    console.error("Error fetching consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation plan" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const body = await request.json();

    // Input validation
    if (body.durationInHours && body.durationInHours <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 }
      );
    }

    if (body.price && body.price <= 0) {
      return NextResponse.json(
        { error: "Price must be a positive number" },
        { status: 400 }
      );
    }

    const consultationPlan = await prisma.consultationPlan.update({
      where: { id: consultationId },
      data: {
        title: body.title,
        description: body.description,
        durationInHours: body.durationInHours,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        language: body.language,
        level: body.level,
        prerequisites: body.prerequisites,
        materialProvided: body.materialProvided,
        learningOutcomes: body.learningOutcomes,
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
    console.error("Error updating consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the consultation plan" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;

    // Check if there are any associated consultations
    const associatedConsultations = await prisma.consultation.findMany({
      where: { consultationPlanId: consultationId },
    });

    if (associatedConsultations.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete consultation plan with associated consultations" },
        { status: 400 }
      );
    }

    const consultationPlan = await prisma.consultationPlan.delete({
      where: { id: consultationId },
      include: {
        consultantProfile: true,
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
    console.error("Error deleting consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the consultation plan" },
      { status: 500 }
    );
  }
}
