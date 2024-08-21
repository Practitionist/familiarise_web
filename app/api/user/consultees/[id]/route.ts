import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const consultee = await prisma.consulteeProfile.findUnique({
      where: { userId: params.id },
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
        user: true,
      },
    });

    if (!consultee) {
      return NextResponse.json({ error: "Consultee not found" }, { status: 404 });
    }

    return NextResponse.json(consultee, { status: 200 });
  } catch (error) {
    console.error("Error getting consultee:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const createdConsultee = await prisma.consulteeProfile.create({
      data: {
        location: body.location,
        onlineStatus: body.onlineStatus,
        currentTimezone: body.currentTimezone,
        user: { connect: { id: params.id } },
      },
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
        user: true,
      },
    });

    return NextResponse.json(createdConsultee, { status: 201 });
  } catch (error) {
    console.error("Error creating consultee:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const updatedConsultee = await prisma.consulteeProfile.update({
      where: { userId: params.id },
      data: {
        location: body.location,
        onlineStatus: body.onlineStatus,
        currentTimezone: body.currentTimezone,
      },
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
        user: true,
      },
    });

    return NextResponse.json(updatedConsultee, { status: 200 });
  } catch (error) {
    console.error("Error updating consultee:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const deletedConsultee = await prisma.consulteeProfile.delete({
      where: { userId: params.id },
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
        user: true,
      },
    });

    return NextResponse.json(deletedConsultee, { status: 200 });
  } catch (error) {
    console.error("Error deleting consultee:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}