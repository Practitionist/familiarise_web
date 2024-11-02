import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { PlanEmailSupport } from "@prisma/client";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const skip = (page - 1) * limit;

    const where = consultantId ? { consultantProfileId: consultantId } : {};

    const [subscriptionPlans, total] = await Promise.all([
      prisma.subscriptionPlan.findMany({
        where,
        include: {
          consultantProfile: true,
        },
        skip,
        take: limit,
      }),
      prisma.subscriptionPlan.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: subscriptionPlans,
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
    console.error("Error fetching subscription plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching subscription plans" },
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
      videoMeetings,
      emailSupport,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
    } = body;

    // Input validation
    if (!title || !durationInMonths || !price || !consultantProfileId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      durationInMonths <= 0 ||
      price <= 0 ||
      callsPerWeek < 0 ||
      videoMeetings < 0
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

    const newSubscriptionPlan = await prisma.subscriptionPlan.create({
      data: {
        title,
        description,
        durationInMonths,
        price,
        callsPerWeek,
        videoMeetings,
        emailSupport,
        language,
        level,
        prerequisites,
        materialProvided,
        learningOutcomes,
        consultantProfile: { connect: { id: consultantProfileId } },
      },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: newSubscriptionPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the subscription plan" },
      { status: 500 },
    );
  }
}
