import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, ScheduleType } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const consultants = await prisma.consultantProfile.findMany({
      include: {
        reviews: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json(consultants, { status: 200 });
  } catch (error) {
    console.error("Error getting consultants:", error);
    return NextResponse.json({ error: "An error occurred while fetching consultants" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Validate required fields
    const requiredFields = ['userId', 'domain', 'subDomains', 'scheduleType'];
    for (const field of requiredFields) {
      if (!body[field]) {
        return NextResponse.json({ error: `Missing required field: ${field}` }, { status: 400 });
      }
    }

    // Validate scheduleType
    if (!Object.values(ScheduleType).includes(body.scheduleType)) {
      return NextResponse.json({ error: "Invalid scheduleType" }, { status: 400 });
    }

    const newConsultant = await prisma.consultantProfile.create({
      data: {
        rating: body.rating || 0,
        specialization: body.specialization,
        experience: body.experience,
        location: body.location,
        description: body.description,
        tags: body.tags,
        domain: body.domain,
        subDomains: body.subDomains,
        scheduleType: body.scheduleType,
        user: { connect: { id: body.userId } },
      },
      include: {
        reviews: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json(newConsultant, { status: 201 });
  } catch (error) {
    console.error("Error creating consultant:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return NextResponse.json({ error: "A consultant profile already exists for this user" }, { status: 400 });
      }
    }
    return NextResponse.json({ error: "An error occurred while creating the consultant profile" }, { status: 500 });
  }
}
