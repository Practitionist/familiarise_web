import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";
import { minutesToTimeString } from "@/utils/slotAllocation/slotTimeUtils";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "consultantProfileId is required" },
        { status: 400 },
      );
    }

    const skip = (page - 1) * limit;

    const [weeklySlots, total] = await Promise.all([
      prisma.slotOfAvailabilityWeekly.findMany({
        where: {
          consultantProfileId: consultantProfileId,
        },
        orderBy: [
          { startDay: "asc" },
          { startTimeUtc: "asc" },
        ],
        include: {
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
        skip,
        take: limit,
      }),
      prisma.slotOfAvailabilityWeekly.count({
        where: { consultantProfileId: consultantProfileId },
      }),
    ]);

    return NextResponse.json(
      {
        data: weeklySlots,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching weekly slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching weekly availability slots" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      consultantProfileId,
      startDay,
      endDay,
      startTimeUtc,
      endTimeUtc,
    } = body;

    if (
      !consultantProfileId ||
      !startDay ||
      !endDay ||
      startTimeUtc === undefined ||
      startTimeUtc === null ||
      endTimeUtc === undefined ||
      endTimeUtc === null
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(startDay) ||
      !Object.values(DayOfWeek).includes(endDay)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

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

    if (startTimeUtc >= endTimeUtc) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots (Int range overlap check)
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: {
        consultantProfileId,
        startDay,
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

    const newWeeklySlot = await prisma.slotOfAvailabilityWeekly.create({
      data: {
        consultantProfileId,
        startDay,
        endDay,
        startTimeUtc,
        endTimeUtc,
      },
      include: {
        consultantProfile: {
          select: {
            id: true,
            user: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: newWeeklySlot }, { status: 201 });
  } catch (error) {
    console.error("Error creating weekly slot:", error);
    return NextResponse.json(
      {
        error: "An error occurred while creating the weekly availability slot",
      },
      { status: 500 },
    );
  }
}
