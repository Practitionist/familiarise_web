import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const consultationPlans = await prisma.consultationPlan.findMany({
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: consultationPlans }, { status: 200 });
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

    const newConsultationPlan = await prisma.consultationPlan.create({
      data: {
        durationInHours,
        price,
        consultantProfileId,
      },
    });

    return NextResponse.json({ data: newConsultationPlan }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
