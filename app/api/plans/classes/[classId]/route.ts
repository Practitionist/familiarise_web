import prisma from "@/lib/prisma";
import { Prisma, PlanEmailSupport } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    const classPlan = await prisma.classPlan.findUniqueOrThrow({
      where: { id: classId },
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
        classes: true,
        topics: true,
        classContents: true,
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
        { status: 404 },
      );
    }
    console.error("Error fetching class plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the class plan" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    const body = await request.json();

    // Input validation
    if (body.durationInMonths && body.durationInMonths <= 0) {
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

    if (body.callsPerWeek && body.callsPerWeek < 0) {
      return NextResponse.json(
        { error: "Calls per week must be a non-negative number" },
        { status: 400 },
      );
    }

    if (body.videoMeetings && body.videoMeetings < 0) {
      return NextResponse.json(
        { error: "Video meetings must be a non-negative number" },
        { status: 400 },
      );
    }

    if (body.maxParticipants && body.maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Maximum participants must be a positive number" },
        { status: 400 },
      );
    }

    if (
      body.emailSupport &&
      !Object.values(PlanEmailSupport).includes(body.emailSupport)
    ) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 },
      );
    }

    const classPlan = await prisma.classPlan.update({
      where: { id: classId },
      data: {
        title: body.title,
        description: body.description,
        durationInMonths: body.durationInMonths,
        price: body.price,
        callsPerWeek: body.callsPerWeek,
        videoMeetings: body.videoMeetings,
        emailSupport: body.emailSupport as PlanEmailSupport,
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
        classContents: body.classContents
          ? {
              deleteMany: {},
              create: body.classContents.map((content: any) => ({
                title: content.title,
                description: content.description,
                contentType: content.contentType,
                contentUrl: content.contentUrl,
                order: content.order,
                hoursAllotted: content.hoursAllotted,
              })),
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
        classes: true,
        topics: true,
        classContents: true,
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
        { status: 404 },
      );
    }
    console.error("Error updating class plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the class plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;

    // Check if there are any associated classes
    const associatedClasses = await prisma.class.findMany({
      where: { classPlanId: classId },
    });

    if (associatedClasses.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete class plan with associated classes" },
        { status: 400 },
      );
    }

    const classPlan = await prisma.classPlan.delete({
      where: { id: classId },
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
        classContents: true,
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
        { status: 404 },
      );
    }
    console.error("Error deleting class plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the class plan" },
      { status: 500 },
    );
  }
}
