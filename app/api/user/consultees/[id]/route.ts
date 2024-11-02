import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
    });

    if (!consultee) {
      return NextResponse.json(
        { error: "Consultee not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: consultee }, { status: 200 });
  } catch (error) {
    console.error("Error getting consultee:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const body = await req.json();
    const user = await prisma.user.findUnique({
      where: { id: id },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const createdConsultee = await prisma.consulteeProfile.create({
      data: {
        education: body.education,
        occupation: body.occupation,
        aboutMe: body.aboutMe,
        preferredCommunicationMethod: body.preferredCommunicationMethod,
        preferredLanguage: body.preferredLanguage,
        specialRequirements: body.specialRequirements,
        interests: body.interests,
        user: { connect: { id: id } },
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
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const body = await req.json();

    const existingConsultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
    });

    if (!existingConsultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const updatedConsultee = await prisma.consulteeProfile.update({
      where: { id: id },
      data: {
        education: body.education,
        occupation: body.occupation,
        aboutMe: body.aboutMe,
        preferredCommunicationMethod: body.preferredCommunicationMethod,
        preferredLanguage: body.preferredLanguage,
        specialRequirements: body.specialRequirements,
        interests: body.interests,
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
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existingConsultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
    });

    if (!existingConsultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const deletedConsultee = await prisma.consulteeProfile.delete({
      where: { id: id },
      include: {
        slotsOfAppointment: true,
        consultantReviews: true,
        user: true,
      },
    });

    return NextResponse.json(deletedConsultee, { status: 200 });
  } catch (error) {
    console.error("Error deleting consultee:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
