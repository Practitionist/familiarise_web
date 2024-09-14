import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const webinarPlans = await prisma.webinarPlan.findMany({
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: webinarPlans }, { status: 200 });
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
    const { durationInHours, price, consultantProfileId } = body;

    const newWebinarPlan = await prisma.webinarPlan.create({
      data: {
        durationInHours,
        price,
        consultantProfileId,
      },
    });

    return NextResponse.json({ data: newWebinarPlan }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
