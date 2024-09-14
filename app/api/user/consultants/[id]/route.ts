import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { ScheduleType } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const consultant = await prisma.consultantProfile.findFirst({
      where: { id: params.id },
      include: {
        reviews: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
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

    if (!body.domain || !Array.isArray(body.subDomains) || body.subDomains.length === 0) {
      return NextResponse.json({ error: "Domain and subDomains are required" }, { status: 400 });
    }

    const consultant = await prisma.consultantProfile.create({
      data: {
        scheduleType: body.scheduleType as ScheduleType,
        rating: body.rating ? parseFloat(body.rating) : 0,
        specialization: body.specialization,
        experience: body.experience,
        location: body.location,
        description: body.description,
        tags: body.tags,
        domain: body.domain,
        subDomains: body.subDomains,
        user: { connect: { id: params.id } },
      },
      include: {
        reviews: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
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

    if (body.domain !== undefined && (!body.subDomains || !Array.isArray(body.subDomains) || body.subDomains.length === 0)) {
      return NextResponse.json({ error: "When updating domain, subDomains must also be provided" }, { status: 400 });
    }

    const consultant = await prisma.consultantProfile.update({
      where: { userId: params.id },
      data: {
        scheduleType: body.scheduleType as ScheduleType,
        rating: body.rating ? parseFloat(body.rating) : undefined,
        specialization: body.specialization,
        experience: body.experience,
        location: body.location,
        description: body.description,
        tags: body.tags,
        domain: body.domain,
        subDomains: body.subDomains,
      },
      include: {
        reviews: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
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
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
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
