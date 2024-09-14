import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const classPlans = await prisma.classPlan.findMany({
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: classPlans }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Something went wrong" },
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

    const newClassPlan = await prisma.classPlan.create({
      data: {
        durationInMonths,
        price,
        callsPerWeek,
        videoMeetings,
        emailSupport,
        consultantProfileId,
      },
    });

    return NextResponse.json({ data: newClassPlan }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
