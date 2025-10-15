import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DayOfWeek } from "@prisma/client";

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
      !body.dayOfWeekForStartsAt ||
      !body.dayOfWeekForEndsAt ||
      !body.availabilityStartsAt ||
      !body.availabilityEndsAt
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(body.dayOfWeekForStartsAt) ||
      !Object.values(DayOfWeek).includes(body.dayOfWeekForEndsAt)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

    const startTime = new Date(body.availabilityStartsAt);
    const endTime = new Date(body.availabilityEndsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: {
        id: { not: id },
        consultantProfileId: body.consultantProfileId,
        dayOfWeekForStartsAt: body.dayOfWeekForStartsAt,
        OR: [
          {
            availabilityStartsAt: { lte: startTime },
            availabilityEndsAt: { gt: startTime },
          },
          {
            availabilityStartsAt: { lt: endTime },
            availabilityEndsAt: { gte: endTime },
          },
          {
            availabilityStartsAt: { gte: startTime },
            availabilityEndsAt: { lte: endTime },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: "This slot overlaps with an existing slot" },
        { status: 409 },
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityWeekly.update({
      where: { id: id },
      data: {
        dayOfWeekForStartsAt: body.dayOfWeekForStartsAt,
        dayOfWeekForEndsAt: body.dayOfWeekForEndsAt,
        availabilityStartsAt: startTime,
        availabilityEndsAt: endTime,
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
      body.dayOfWeekForStartsAt &&
      !Object.values(DayOfWeek).includes(body.dayOfWeekForStartsAt)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week for start time" },
        { status: 400 },
      );
    }

    if (
      body.dayOfWeekForEndsAt &&
      !Object.values(DayOfWeek).includes(body.dayOfWeekForEndsAt)
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

    const startTime = body.availabilityStartsAt
      ? new Date(body.availabilityStartsAt)
      : currentSlot.availabilityStartsAt;
    const endTime = body.availabilityEndsAt
      ? new Date(body.availabilityEndsAt)
      : currentSlot.availabilityEndsAt;

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: {
        id: { not: id },
        consultantProfileId:
          body.consultantProfileId || currentSlot.consultantProfileId,
        dayOfWeekForStartsAt:
          body.dayOfWeekForStartsAt ||
          currentSlot.dayOfWeekForStartsAt,
        OR: [
          {
            availabilityStartsAt: { lte: startTime },
            availabilityEndsAt: { gt: startTime },
          },
          {
            availabilityStartsAt: { lt: endTime },
            availabilityEndsAt: { gte: endTime },
          },
          {
            availabilityStartsAt: { gte: startTime },
            availabilityEndsAt: { lte: endTime },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: "This slot overlaps with an existing slot" },
        { status: 409 },
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityWeekly.update({
      where: { id: id },
      data: {
        dayOfWeekForStartsAt: body.dayOfWeekForStartsAt,
        dayOfWeekForEndsAt: body.dayOfWeekForEndsAt,
        availabilityStartsAt: startTime,
        availabilityEndsAt: endTime,
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
