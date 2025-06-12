import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";
import { addDays, startOfDay, endOfDay } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import {
  processWeeklySlots,
  splitSlotsByDay,
  convertToSlotTimings,
  groupSlotsByDate,
  WeeklySlot,
  dayMap,
  dayToNumber
} from "@/utils/timeSlotsProcessing";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const timezone = searchParams.get("timezone") || "UTC";

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "consultantProfileId is required" },
        { status: 400 },
      );
    }

    const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
      where: { consultantProfileId: consultantProfileId },
    });

    // Convert to utility interface
    const slotData: WeeklySlot[] = weeklySlots.map((slot) => ({
      id: slot.id,
      dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
      slotStartTimeInUTC: slot.slotStartTimeInUTC,
      dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
      slotEndTimeInUTC: slot.slotEndTimeInUTC,
    }));

    // Get current week range
    const refDate = new Date();
    const startOfTodayInTz = startOfDay(toZonedTime(refDate, timezone));
    const startOfWeek = startOfTodayInTz;
    const endOfWeek = addDays(startOfWeek, 7);

    // Process slots using the unified utility
    const processedSlots = processWeeklySlots(slotData, startOfWeek, endOfWeek, timezone);
    const splitSlots = splitSlotsByDay(processedSlots, timezone);
    const slotTimings = convertToSlotTimings(splitSlots, [], timezone); // No appointments for weekly view
    
    // Group by day of week instead of date for weekly view
    const slotsByDay: Record<
      DayOfWeek,
      {
        id: string;
        localStartTime: string;
        localEndTime: string;
        originalSlot: any;
      }[]
    > = {
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
      SATURDAY: [],
      SUNDAY: [],
    };

    slotTimings.forEach((slot) => {
      const originalSlot = weeklySlots.find(s => s.id === slot.slotOfAvailabilityId);
      if (originalSlot) {
        slotsByDay[slot.dayOfWeek].push({
          id: slot.slotId,
          localStartTime: slot.localStartTime,
          localEndTime: slot.localEndTime,
          originalSlot: originalSlot,
        });
      }
    });

    // Sort slots within each day
    for (const day in slotsByDay) {
      slotsByDay[day as DayOfWeek].sort((a, b) =>
        a.localStartTime.localeCompare(b.localStartTime, undefined, {
          numeric: true,
        }),
      );
    }

    return NextResponse.json({ data: slotsByDay }, { status: 200 });
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
      dayOfWeekforStartTimeInUTC,
      dayOfWeekforEndTimeInUTC,
      slotStartTimeInUTC,
      slotEndTimeInUTC,
    } = body;

    if (
      !consultantProfileId ||
      !dayOfWeekforStartTimeInUTC ||
      !dayOfWeekforEndTimeInUTC ||
      !slotStartTimeInUTC ||
      !slotEndTimeInUTC
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(dayOfWeekforStartTimeInUTC) ||
      !Object.values(DayOfWeek).includes(dayOfWeekforEndTimeInUTC)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

    if (
      isNaN(Date.parse(slotStartTimeInUTC)) ||
      isNaN(Date.parse(slotEndTimeInUTC))
    ) {
      return NextResponse.json(
        { error: "Invalid time format" },
        { status: 400 },
      );
    }

    const startTime = new Date(slotStartTimeInUTC);
    const endTime = new Date(slotEndTimeInUTC);

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
        dayOfWeekforStartTimeInUTC,
        OR: [
          {
            slotStartTimeInUTC: { lte: startTime },
            slotEndTimeInUTC: { gt: startTime },
          },
          {
            slotStartTimeInUTC: { lt: endTime },
            slotEndTimeInUTC: { gte: endTime },
          },
          {
            slotStartTimeInUTC: { gte: startTime },
            slotEndTimeInUTC: { lte: endTime },
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
        dayOfWeekforStartTimeInUTC,
        dayOfWeekforEndTimeInUTC,
        slotStartTimeInUTC: startTime,
        slotEndTimeInUTC: endTime,
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
