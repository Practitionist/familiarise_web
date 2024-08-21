import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const consultant = await prisma.consultantProfile.findUnique({
      where: { userId: params.id },
      include: {
        reviews: true,
        slotsOfAvailabiltyWeekly: true,
        slotsOfAvailabiltyCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
        user: true,
      },
    });

    if (!consultant) {
      return NextResponse.json({ error: "Consultant not found" }, { status: 404 });
    }

    return NextResponse.json(consultant, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const consultant = await prisma.consultantProfile.create({
      data: {
        scheduleType: body.scheduleType,
        rating: body.rating,
        specialization: body.specialization,
        experience: body.experience,
        location: body.location,
        description: body.description,
        tags: body.tags,
        onlineStatus: body.onlineStatus,
        currentTimezone: body.currentTimezone,
        domain: body.domain,
        subDomains: body.subDomains,
        user: { connect: { id: params.id } },
      },
      include: {
        reviews: true,
        slotsOfAvailabiltyWeekly: true,
        slotsOfAvailabiltyCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
        user: true,
      },
    });

    return NextResponse.json(consultant, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const consultant = await prisma.consultantProfile.update({
      where: { userId: params.id },
      data: {
        scheduleType: body.scheduleType,
        rating: body.rating,
        specialization: body.specialization,
        experience: body.experience,
        location: body.location,
        description: body.description,
        tags: body.tags,
        onlineStatus: body.onlineStatus,
        currentTimezone: body.currentTimezone,
        domain: body.domain,
        subDomains: body.subDomains,
      },
      include: {
        reviews: true,
        slotsOfAvailabiltyWeekly: true,
        slotsOfAvailabiltyCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
        user: true,
      },
    });

    return NextResponse.json(consultant, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const consultant = await prisma.consultantProfile.delete({
      where: { userId: params.id },
      include: {
        reviews: true,
        slotsOfAvailabiltyWeekly: true,
        slotsOfAvailabiltyCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
        user: true,
      },
    });

    return NextResponse.json(consultant, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
