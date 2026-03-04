import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DayOfWeek } from "@prisma/client";
import {
  minutesToTimeString,
  validateWeeklySlotTimeOrder,
  buildWeeklyOverlapWhere,
} from "@/utils/slotAllocation/slotTimeUtils";
import { getSession } from "@/lib/auth-server";

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

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Fetch existing slot for authoritative consultantProfileId and ownership
    const currentSlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (currentSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

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

    if (
      typeof startTimeUtc !== "number" ||
      typeof endTimeUtc !== "number" ||
      !Number.isInteger(startTimeUtc) ||
      !Number.isInteger(endTimeUtc) ||
      startTimeUtc < 0 ||
      startTimeUtc > 1439 ||
      endTimeUtc < 0 ||
      endTimeUtc > 1439
    ) {
      return NextResponse.json(
        { error: "Invalid time format: must be integer 0-1439 (minutes since midnight UTC)" },
        { status: 400 },
      );
    }

    // Day-aware time order validation (supports overnight slots)
    const timeError = validateWeeklySlotTimeOrder(body.startDay, body.endDay, startTimeUtc, endTimeUtc);
    if (timeError) {
      return NextResponse.json({ error: timeError }, { status: 400 });
    }

    // Use authoritative consultantProfileId from existing slot (FIX 9)
    const effectiveConsultantProfileId = currentSlot.consultantProfileId;

    // Reject consultant reassignment
    if (body.consultantProfileId && body.consultantProfileId !== effectiveConsultantProfileId) {
      return NextResponse.json(
        { error: "Cannot reassign slot to a different consultant" },
        { status: 400 },
      );
    }

    // Cross-midnight-aware overlap check
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: buildWeeklyOverlapWhere(
        effectiveConsultantProfileId,
        body.startDay,
        body.endDay,
        startTimeUtc,
        endTimeUtc,
        id,
      ),
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

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

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
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (currentSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    // Reject consultant reassignment
    if (body.consultantProfileId && body.consultantProfileId !== currentSlot.consultantProfileId) {
      return NextResponse.json(
        { error: "Cannot reassign slot to a different consultant" },
        { status: 400 },
      );
    }

    const startTimeUtc: number = body.startTimeUtc ?? currentSlot.startTimeUtc;
    const endTimeUtc: number = body.endTimeUtc ?? currentSlot.endTimeUtc;

    if (
      (body.startTimeUtc !== undefined && (typeof body.startTimeUtc !== "number" || !Number.isInteger(body.startTimeUtc))) ||
      (body.endTimeUtc !== undefined && (typeof body.endTimeUtc !== "number" || !Number.isInteger(body.endTimeUtc))) ||
      startTimeUtc < 0 ||
      startTimeUtc > 1439 ||
      endTimeUtc < 0 ||
      endTimeUtc > 1439
    ) {
      return NextResponse.json(
        { error: "Invalid time format: must be integer 0-1439 (minutes since midnight UTC)" },
        { status: 400 },
      );
    }

    const effectiveStartDay = body.startDay || currentSlot.startDay;
    const effectiveEndDay = body.endDay || currentSlot.endDay;

    // Day-aware time order validation (supports overnight slots)
    const timeError = validateWeeklySlotTimeOrder(effectiveStartDay, effectiveEndDay, startTimeUtc, endTimeUtc);
    if (timeError) {
      return NextResponse.json({ error: timeError }, { status: 400 });
    }

    // Cross-midnight-aware overlap check using authoritative consultantProfileId
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: buildWeeklyOverlapWhere(
        currentSlot.consultantProfileId,
        effectiveStartDay,
        effectiveEndDay,
        startTimeUtc,
        endTimeUtc,
        id,
      ),
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

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const weeklySlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!weeklySlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (weeklySlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
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
