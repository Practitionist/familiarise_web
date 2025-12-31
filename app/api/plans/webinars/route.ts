import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const includeRegistration =
      searchParams.get("includeRegistration") === "true";
    const skip = (page - 1) * limit;

    const where = consultantId ? { consultantProfileId: consultantId } : {};

    // Build include object based on whether registration data is requested
    const include: Record<string, unknown> = {
      consultantProfile: true,
      topics: true,
    };

    // Include webinar instances with appointment/slot/user data for registration checks
    if (includeRegistration) {
      include.webinars = {
        include: {
          appointment: {
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

    const [webinarPlans, total] = await Promise.all([
      prisma.webinarPlan.findMany({
        where,
        include,
        skip,
        take: limit,
      }),
      prisma.webinarPlan.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: webinarPlans,
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
    console.error("Error fetching webinar plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinar plans" },
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
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
    } = body;

    // Input validation
    if (
      !title ||
      !durationInHours ||
      !price ||
      !maxParticipants ||
      !consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (durationInHours <= 0 || price <= 0 || maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Invalid numeric values" },
        { status: 400 },
      );
    }

    const newWebinarPlan = await prisma.webinarPlan.create({
      data: {
        title,
        description,
        durationInHours,
        price,
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
      },
      include: {
        consultantProfile: true,
        topics: true,
      },
    });

    return NextResponse.json({ data: newWebinarPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar plan" },
      { status: 500 },
    );
  }
}
