import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const subscriptionPlans = await prisma.subscriptionPlan.findMany({
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: subscriptionPlans }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      durationInMonths,
      price,
      callsPerWeek,
      videoMeetings,
      emailSupport,
      consultantProfileId,
    } = body;

    const newSubscriptionPlan = await prisma.subscriptionPlan.create({
      data: {
        durationInMonths,
        price,
        callsPerWeek,
        videoMeetings,
        emailSupport,
        consultantProfileId,
      },
    });

    return NextResponse.json({ data: newSubscriptionPlan }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
