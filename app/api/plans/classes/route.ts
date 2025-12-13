import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { PlanEmailSupport } from "@prisma/client";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const includeClasses = searchParams.get("include")?.includes("classes");
    const includeRegistration = searchParams.get("includeRegistration") === "true";
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const skip = (page - 1) * limit;

    const where = consultantId ? { consultantProfileId: consultantId } : {};

    // Build classes include based on whether registration data is requested
    let classesInclude: boolean | Record<string, unknown> = true;
    if (includeRegistration) {
      classesInclude = {
        include: {
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: { select: { id: true } }, // Only fetch user IDs for registration check
                },
              },
            },
          },
        },
      };
    }

    const includeOptions = {
      consultantProfile: true,
      topics: true,
      classContents: true,
      // Include classes with registration data if requested, otherwise include only if explicitly asked
      ...((includeClasses || includeRegistration) && { classes: classesInclude }),
    };

    const [classPlans, total] = await Promise.all([
      prisma.classPlan.findMany({
        where,
        include: includeOptions,
        skip,
        take: limit,
      }),
      prisma.classPlan.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: classPlans,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching class plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching class plans" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      description,
      durationInMonths,
      price,
      callsPerWeek,
      sessionDurationInHours,
      videoMeetings,
      emailSupport,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
      classContents,
    } = body;

    // Input validation
    if (
      !title ||
      !durationInMonths ||
      !price ||
      !maxParticipants ||
      !consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      durationInMonths <= 0 ||
      price <= 0 ||
      callsPerWeek < 0 ||
      (sessionDurationInHours && sessionDurationInHours <= 0) ||
      videoMeetings < 0 ||
      maxParticipants <= 0
    ) {
      return NextResponse.json(
        { error: "Invalid numeric values" },
        { status: 400 },
      );
    }

    if (!Object.values(PlanEmailSupport).includes(emailSupport)) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 },
      );
    }

    const newClassPlan = await prisma.classPlan.create({
      data: {
        title,
        description,
        durationInMonths,
        price,
        callsPerWeek,
        sessionDurationInHours: sessionDurationInHours || 1,
        videoMeetings,
        emailSupport,
        maxParticipants,
        language,
        level,
        prerequisites,
        materialProvided,
        learningOutcomes,
        consultantProfile: { connect: { id: consultantProfileId } },
        topics: topicIds
          ? { connect: topicIds.map((id: string) => ({ id })) }
          : undefined,
        classContents: {
          create: classContents.map((content: any) => ({
            title: content.title,
            description: content.description,
            contentType: content.contentType,
            contentUrl: content.contentUrl,
            order: content.order,
            hoursAllotted: content.hoursAllotted,
          })),
        },
      },
      include: {
        consultantProfile: true,
        topics: true,
        classContents: true,
      },
    });

    return NextResponse.json({ data: newClassPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating class plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the class plan" },
      { status: 500 },
    );
  }
}
