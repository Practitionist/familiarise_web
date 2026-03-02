import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DayOfWeek } from "@prisma/client";
import { minutesToTimeString } from "@/utils/slotAllocation/slotTimeUtils";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const weeklySlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    if (!weeklySlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: weeklySlot }, { status: 200 });
  } catch (error) {
    console.error("Error fetching weekly slot:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the weekly slot" },
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

    if (
      !body.startDay ||
      !body.endDay ||
      body.startTimeUtc === undefined ||
      body.startTimeUtc === null ||
      body.endTimeUtc === undefined ||
      body.endTimeUtc === null
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(body.startDay) ||
      !Object.values(DayOfWeek).includes(body.endDay)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

    const startTimeUtc: number = body.startTimeUtc;
    const endTimeUtc: number = body.endTimeUtc;

    if (startTimeUtc >= endTimeUtc) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots (Int range overlap check)
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: {
        id: { not: id },
        consultantProfileId: body.consultantProfileId,
        startDay: body.startDay,
        OR: [
          {
            startTimeUtc: { lte: startTimeUtc },
            endTimeUtc: { gt: startTimeUtc },
          },
          {
            startTimeUtc: { lt: endTimeUtc },
            endTimeUtc: { gte: endTimeUtc },
          },
          {
            startTimeUtc: { gte: startTimeUtc },
            endTimeUtc: { lte: endTimeUtc },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: `This slot (${minutesToTimeString(startTimeUtc)}-${minutesToTimeString(endTimeUtc)}) overlaps with an existing slot` },
        { status: 409 },
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityWeekly.update({
      where: { id: id },
      data: {
        startDay: body.startDay,
        endDay: body.endDay,
        startTimeUtc,
        endTimeUtc,
        consultantProfile: body.consultantProfileId
          ? { connect: { id: body.consultantProfileId } }
          : undefined,
      },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: updatedSlot }, { status: 200 });
  } catch (error) {
    console.error("Error updating weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Weekly slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the weekly slot" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();

    if (
      body.startDay &&
      !Object.values(DayOfWeek).includes(body.startDay)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week for start time" },
        { status: 400 },
      );
    }

    if (
      body.endDay &&
      !Object.values(DayOfWeek).includes(body.endDay)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week for end time" },
        { status: 400 },
      );
    }

    const currentSlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id: id },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    const startTimeUtc: number = body.startTimeUtc ?? currentSlot.startTimeUtc;
    const endTimeUtc: number = body.endTimeUtc ?? currentSlot.endTimeUtc;

    if (startTimeUtc >= endTimeUtc) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots (Int range overlap check)
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: {
        id: { not: id },
        consultantProfileId:
          body.consultantProfileId || currentSlot.consultantProfileId,
        startDay:
          body.startDay || currentSlot.startDay,
        OR: [
          {
            startTimeUtc: { lte: startTimeUtc },
            endTimeUtc: { gt: startTimeUtc },
          },
          {
            startTimeUtc: { lt: endTimeUtc },
            endTimeUtc: { gte: endTimeUtc },
          },
          {
            startTimeUtc: { gte: startTimeUtc },
            endTimeUtc: { lte: endTimeUtc },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: `This slot (${minutesToTimeString(startTimeUtc)}-${minutesToTimeString(endTimeUtc)}) overlaps with an existing slot` },
        { status: 409 },
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityWeekly.update({
      where: { id: id },
      data: {
        startDay: body.startDay,
        endDay: body.endDay,
        startTimeUtc,
        endTimeUtc,
        consultantProfile: body.consultantProfileId
          ? { connect: { id: body.consultantProfileId } }
          : undefined,
      },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: updatedSlot }, { status: 200 });
  } catch (error) {
    console.error("Error partially updating weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Weekly slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the weekly slot" },
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
    // Check if there are any associated appointments
    const associatedAppointments = await prisma.slotOfAppointment.findMany({
      where: { id: id },
    });

    if (associatedAppointments.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete weekly slot with associated appointments" },
        { status: 400 },
      );
    }

    const deletedSlot = await prisma.slotOfAvailabilityWeekly.delete({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json(
      { message: "Weekly slot deleted successfully", data: deletedSlot },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting weekly slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Weekly slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the weekly slot" },
      { status: 500 },
    );
  }
}
