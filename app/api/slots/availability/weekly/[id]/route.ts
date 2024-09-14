import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DayOfWeek } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const weeklySlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    if (!weeklySlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(weeklySlot, { status: 200 });

  } catch (error) {
    console.error("Error fetching weekly slot:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the weekly slot" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: NextRequest
) {
  try {
    const body = await req.json();

    if (!body.consultantProfileId || !body.dayOfWeekforStartTimeInUTC || !body.dayOfWeekforEndTimeInUTC || !body.slotStartTimeInUTC || !body.slotEndTimeInUTC) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!Object.values(DayOfWeek).includes(body.dayOfWeekforStartTimeInUTC) || !Object.values(DayOfWeek).includes(body.dayOfWeekforEndTimeInUTC)) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 }
      );
    }

    const newSlot = await prisma.slotOfAvailabilityWeekly.create({
      data: {
        consultantProfile: { connect: { id: body.consultantProfileId } },
        dayOfWeekforStartTimeInUTC: body.dayOfWeekforStartTimeInUTC,
        dayOfWeekforEndTimeInUTC: body.dayOfWeekforEndTimeInUTC,
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
      },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(newSlot, { status: 201 });
  } catch (error) {
    console.error("Error creating weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return NextResponse.json(
          { error: "A slot with this time range already exists" },
          { status: 400 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while creating the weekly slot" },
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

    if (!body.dayOfWeekforStartTimeInUTC || !body.dayOfWeekforEndTimeInUTC || !body.slotStartTimeInUTC || !body.slotEndTimeInUTC) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!Object.values(DayOfWeek).includes(body.dayOfWeekforStartTimeInUTC) || !Object.values(DayOfWeek).includes(body.dayOfWeekforEndTimeInUTC)) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 }
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityWeekly.update({
      where: { id: params.id },
      data: {
        dayOfWeekforStartTimeInUTC: body.dayOfWeekforStartTimeInUTC,
        dayOfWeekforEndTimeInUTC: body.dayOfWeekforEndTimeInUTC,
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
        consultantProfile: body.consultantProfileId ? { connect: { id: body.consultantProfileId } } : undefined,
      },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error updating weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: "Weekly slot not found" },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the weekly slot" },
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

    if (body.dayOfWeekforStartTimeInUTC && !Object.values(DayOfWeek).includes(body.dayOfWeekforStartTimeInUTC)) {
      return NextResponse.json(
        { error: "Invalid day of week for start time" },
        { status: 400 }
      );
    }

    if (body.dayOfWeekforEndTimeInUTC && !Object.values(DayOfWeek).includes(body.dayOfWeekforEndTimeInUTC)) {
      return NextResponse.json(
        { error: "Invalid day of week for end time" },
        { status: 400 }
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityWeekly.update({
      where: { id: params.id },
      data: {
        dayOfWeekforStartTimeInUTC: body.dayOfWeekforStartTimeInUTC,
        dayOfWeekforEndTimeInUTC: body.dayOfWeekforEndTimeInUTC,
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
        consultantProfile: body.consultantProfileId ? { connect: { id: body.consultantProfileId } } : undefined,
      },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error partially updating weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: "Weekly slot not found" },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the weekly slot" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const deletedSlot = await prisma.slotOfAvailabilityWeekly.delete({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        slotsOfAppointment: true,
      },
    });

    return NextResponse.json(
      { message: "Weekly slot deleted successfully", data: deletedSlot },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return NextResponse.json(
          { error: "Weekly slot not found" },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the weekly slot" },
      { status: 500 }
    );
  }
}
