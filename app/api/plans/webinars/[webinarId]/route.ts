import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const webinarPlan = await prisma.webinarPlan.findUniqueOrThrow({
      where: { id: webinarId },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        webinars: true,
        topics: true,
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
        { status: 404 },
      );
    }
    console.error("Error fetching webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the webinar plan" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const body = await request.json();

    // Input validation
    if (body.durationInHours && body.durationInHours <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 },
      );
    }

    if (body.price && body.price <= 0) {
      return NextResponse.json(
        { error: "Price must be a positive number" },
        { status: 400 },
      );
    }

    if (body.maxParticipants && body.maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Maximum participants must be a positive number" },
        { status: 400 },
      );
    }

    const webinarPlan = await prisma.webinarPlan.update({
      where: { id: webinarId },
      data: {
        title: body.title,
        description: body.description,
        durationInHours: body.durationInHours,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        maxParticipants: body.maxParticipants,
        language: body.language,
        level: body.level,
        prerequisites: body.prerequisites,
        materialProvided: body.materialProvided,
        learningOutcomes: body.learningOutcomes,
        consultantProfile: body.consultantProfileId
          ? {
              connect: { id: body.consultantProfileId },
            }
          : undefined,
        topics: body.topicIds
          ? {
              set: body.topicIds.map((id: string) => ({ id })),
            }
          : undefined,
      },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        webinars: true,
        topics: true,
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
        { status: 404 },
      );
    }
    console.error("Error updating webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the webinar plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;

    // Check if there are any associated webinars
    const associatedWebinars = await prisma.webinar.findMany({
      where: { webinarPlanId: webinarId },
    });

    if (associatedWebinars.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete webinar plan with associated webinars" },
        { status: 400 },
      );
    }

    const webinarPlan = await prisma.webinarPlan.delete({
      where: { id: webinarId },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
            domain: true,
            subDomains: true,
            tags: true,
          },
        },
        topics: true,
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
        { status: 404 },
      );
    }
    console.error("Error deleting webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the webinar plan" },
      { status: 500 },
    );
  }
}
