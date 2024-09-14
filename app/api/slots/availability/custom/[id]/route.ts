import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const customSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    if (!customSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(customSlot, { status: 200 });

  } catch (error) {
    console.error("Error fetching custom slot:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the custom slot" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest
) {
  try {
    const body = await req.json();

    if (!body.consultantProfileId || !body.slotStartTimeInUTC || !body.slotEndTimeInUTC) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const newSlot = await prisma.slotOfAvailabilityCustom.create({
      data: {
        consultantProfile: { connect: { id: body.consultantProfileId } },
        slotStartTimeInUTC: new Date(body.slotStartTimeInUTC),
        slotEndTimeInUTC: new Date(body.slotEndTimeInUTC),
      },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(newSlot, { status: 201 });
  } catch (error) {
    console.error("Error creating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return NextResponse.json(
          { error: "A slot with this time range already exists" },
          { status: 400 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while creating the custom slot" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    if (!body.slotStartTimeInUTC || !body.slotEndTimeInUTC) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityCustom.update({
      where: { id: params.id },
      data: {
        slotStartTimeInUTC: new Date(body.slotStartTimeInUTC),
        slotEndTimeInUTC: new Date(body.slotEndTimeInUTC),
        consultantProfile: body.consultantProfileId ? { connect: { id: body.consultantProfileId } } : undefined,
      },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error updating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the custom slot" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const updatedSlot = await prisma.slotOfAvailabilityCustom.update({
      where: { id: params.id },
      data: {
        slotStartTimeInUTC: body.slotStartTimeInUTC ? new Date(body.slotStartTimeInUTC) : undefined,
        slotEndTimeInUTC: body.slotEndTimeInUTC ? new Date(body.slotEndTimeInUTC) : undefined,
        consultantProfile: body.consultantProfileId ? { connect: { id: body.consultantProfileId } } : undefined,
      },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error partially updating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the custom slot" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const deletedSlot = await prisma.slotOfAvailabilityCustom.delete({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(
      { message: "Custom slot deleted successfully", data: deletedSlot },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the custom slot" },
      { status: 500 }
    );
  }
}
