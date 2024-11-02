import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const skip = (page - 1) * limit;

    const where = consultantId ? { consultantProfileId: consultantId } : {};

    const [consultationPlans, total] = await Promise.all([
      prisma.consultationPlan.findMany({
        where,
        include: {
          consultantProfile: true,
        },
        skip,
        take: limit,
      }),
      prisma.consultationPlan.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: consultationPlans,
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
    console.error("Error fetching consultation plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultation plans" },
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
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
    } = body;

    // Input validation
    if (!title || !durationInHours || !price || !consultantProfileId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const newConsultationPlan = await prisma.consultationPlan.create({
      data: {
        title,
        description,
        durationInHours,
        price,
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

    return NextResponse.json({ data: newConsultationPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating consultation plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the consultation plan" },
      { status: 500 },
    );
  }
}
