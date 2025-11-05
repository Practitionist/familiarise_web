import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";

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
          { dayOfWeekForStartsAt: "asc" },
          { availabilityStartsAt: "asc" },
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
      dayOfWeekForStartsAt,
      dayOfWeekForEndsAt,
      availabilityStartsAt,
      availabilityEndsAt,
    } = body;

    if (
      !consultantProfileId ||
      !dayOfWeekForStartsAt ||
      !dayOfWeekForEndsAt ||
      !availabilityStartsAt ||
      !availabilityEndsAt
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(dayOfWeekForStartsAt) ||
      !Object.values(DayOfWeek).includes(dayOfWeekForEndsAt)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

    if (
      isNaN(Date.parse(availabilityStartsAt)) ||
      isNaN(Date.parse(availabilityEndsAt))
    ) {
      return NextResponse.json(
        { error: "Invalid time format" },
        { status: 400 },
      );
    }

    const startTime = new Date(availabilityStartsAt);
    const endTime = new Date(availabilityEndsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: {
        consultantProfileId,
        dayOfWeekForStartsAt,
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

    const newWeeklySlot = await prisma.slotOfAvailabilityWeekly.create({
      data: {
        consultantProfileId,
        dayOfWeekForStartsAt,
        dayOfWeekForEndsAt,
        availabilityStartsAt: startTime,
        availabilityEndsAt: endTime,
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
