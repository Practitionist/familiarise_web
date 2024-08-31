import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const consultants = await prisma.consultantProfile.findMany({
      include: {
        reviews: true,
        slotsOfAvailabiltyWeekly: true,
        slotsOfAvailabiltyCustom: true,
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
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

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
        onlineStatus: body.onlineStatus || false,
        scheduleType: body.scheduleType,
        user: { connect: { id: body.userId } },
      },
      include: {
        reviews: true,
        slotsOfAvailabiltyWeekly: true,
        slotsOfAvailabiltyCustom: true,
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
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
