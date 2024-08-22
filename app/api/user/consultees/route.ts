import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const consultees = await prisma.consulteeProfile.findMany({
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
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

    return NextResponse.json(consultees, { status: 200 });
  } catch (error) {
    console.error("Error getting consultees:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const newConsultee = await prisma.consulteeProfile.create({
      data: {
        location: body.location,
        onlineStatus: body.onlineStatus,
        currentTimezone: body.currentTimezone,
        user: { connect: { id: body.userId } },
      },
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
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

    return NextResponse.json(newConsultee, { status: 201 });
  } catch (error) {
    console.error("Error creating consultee:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
