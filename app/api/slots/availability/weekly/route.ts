import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";
import {
  minutesToTimeString,
  validateWeeklySlotTimeOrder,
  buildWeeklyOverlapWhere,
  getTimezoneOffsetMinutes,
} from "@/utils/slotAllocation/slotTimeUtils";
import { getSession } from "@/lib/auth-server";
import { toLocalMinutes, toLocalDay } from "@/utils/slotAllocation/localTime";

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
        orderBy: [{ startDay: "asc" }, { startTimeUtc: "asc" }],
        include: {
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
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
    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const { consultantProfileId, startDay, endDay, startTimeUtc, endTimeUtc } =
      body;

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

    // Ownership check (also fetch user timezone for offset computation)
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfileId },
      select: { userId: true, user: { select: { timezone: true } } },
    });
    if (!consultantProfile || consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this consultant profile" },
        { status: 403 },
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
        {
          error:
            "Invalid time format: must be integer 0-1439 (minutes since midnight UTC)",
        },
        { status: 400 },
      );
    }

    // Day-aware time order validation (supports overnight slots)
    const timeError = validateWeeklySlotTimeOrder(
      startDay,
      endDay,
      startTimeUtc,
      endTimeUtc,
    );
    if (timeError) {
      return NextResponse.json({ error: timeError }, { status: 400 });
    }

    // Cross-midnight-aware overlap check
    const overlappingSlot = await prisma.slotOfAvailabilityWeekly.findFirst({
      where: buildWeeklyOverlapWhere(
        consultantProfileId,
        startDay,
        endDay,
        startTimeUtc,
        endTimeUtc,
      ),
    });

    if (overlappingSlot) {
      return NextResponse.json(
        {
          error: `This slot (${minutesToTimeString(startTimeUtc)}-${minutesToTimeString(endTimeUtc)}) overlaps with an existing slot`,
        },
        { status: 409 },
      );
    }

    const utcOffsetMinutes = consultantProfile.user?.timezone
      ? getTimezoneOffsetMinutes(consultantProfile.user.timezone)
      : 0;
    // #503 — persist the DST-proof source of truth alongside the frozen
    // offset; the slot math migrates read-side in the follow-up.
    const timezone = consultantProfile.user?.timezone ?? null;
    const localStartMinutes = toLocalMinutes(startTimeUtc, utcOffsetMinutes);
    const localEndMinutes = toLocalMinutes(endTimeUtc, utcOffsetMinutes);
    const localStartDay = toLocalDay(startDay, startTimeUtc, utcOffsetMinutes);
    const localEndDay = toLocalDay(endDay, endTimeUtc, utcOffsetMinutes);

    const newWeeklySlot = await prisma.slotOfAvailabilityWeekly.create({
      data: {
        consultantProfileId,
        startDay,
        endDay,
        startTimeUtc,
        endTimeUtc,
        utcOffsetMinutes,
        timezone,
        localStartMinutes,
        localEndMinutes,
        localStartDay,
        localEndDay,
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
