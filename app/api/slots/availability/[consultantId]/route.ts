import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek, ScheduleType } from "@prisma/client";
import { endOfDay, parseISO, startOfDay } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

// Assuming TSlotTiming is defined in a types file
import { TSlotTiming } from "@/types/slots";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;

    const date = req.nextUrl.searchParams.get("date");
    const userTimeZone = req.nextUrl.searchParams.get("timeZone");
    const page = parseInt(req.nextUrl.searchParams.get("page") || "1");
    const limit = parseInt(req.nextUrl.searchParams.get("limit") || "10");

    if (!consultantId || !date || !userTimeZone) {
      return NextResponse.json(
        { error: "Consultant ID, date, and timezone are required" },
        { status: 400 },
      );
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { scheduleType: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    const userDate = toZonedTime(parseISO(date), userTimeZone);
    const userDayStart = startOfDay(userDate);
    const userDayEnd = endOfDay(userDate);
    const utcDayStart = fromZonedTime(userDayStart, userTimeZone);
    const utcDayEnd = fromZonedTime(userDayEnd, userTimeZone);

    let slots: TSlotTiming[] = [];

    if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
      slots = await getWeeklySlots(consultantId, userDate, userTimeZone);
    } else if (consultantProfile.scheduleType === ScheduleType.CUSTOM) {
      slots = await getCustomSlots(
        consultantId,
        utcDayStart,
        utcDayEnd,
        userTimeZone,
      );
    }

    slots = filterSlots(slots, userDayStart, userDayEnd);
    slots = await removeBookedSlots(slots);
    slots = filterExpiredSlots(slots);

    const totalSlots = slots.length;
    const paginatedSlots = slots.slice((page - 1) * limit, page * limit);

    return NextResponse.json(
      {
        data: paginatedSlots,
        meta: {
          total: totalSlots,
          page,
          limit,
          totalPages: Math.ceil(totalSlots / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching availability slots" },
      { status: 500 },
    );
  }
}

async function getWeeklySlots(
  consultantId: string,
  userDate: Date,
  userTimeZone: string,
): Promise<TSlotTiming[]> {
  const userDayOfWeek = getDayOfWeek(userDate);
  const previousDayOfWeek = getPreviousDayOfWeek(userDayOfWeek);

  const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
    where: {
      consultantProfileId: consultantId,
      OR: [
        { dayOfWeekForStartsAt: userDayOfWeek },
        {
          dayOfWeekForStartsAt: previousDayOfWeek,
          dayOfWeekForEndsAt: userDayOfWeek,
        },
      ],
    },
    orderBy: { availabilityStartsAt: "asc" },
  });

  return weeklySlots.map((slot) =>
    mapWeeklySlotToTiming(slot, userDate, userTimeZone),
  );
}

async function getCustomSlots(
  consultantId: string,
  utcDayStart: Date,
  utcDayEnd: Date,
  userTimeZone: string,
): Promise<TSlotTiming[]> {
  const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
    where: {
      consultantProfileId: consultantId,
      OR: [
        {
          availabilityStartsAt: {
            gte: utcDayStart,
            lt: utcDayEnd,
          },
        },
        {
          availabilityEndsAt: {
            gt: utcDayStart,
            lte: utcDayEnd,
          },
        },
      ],
    },
    orderBy: { availabilityStartsAt: "asc" },
  });

  return customSlots.map((slot) => mapCustomSlotToTiming(slot, userTimeZone));
}

function filterSlots(
  slots: TSlotTiming[],
  userDayStart: Date,
  userDayEnd: Date,
): TSlotTiming[] {
  return slots.filter((slot) => {
    const slotStart = parseISO(slot.dateInISO);
    const slotEnd = parseISO(slot.slotEndTimeInUTC);
    return slotStart < userDayEnd && slotEnd > userDayStart;
  });
}

async function removeBookedSlots(slots: TSlotTiming[]): Promise<TSlotTiming[]> {
  const appointments = await prisma.appointment.findMany({
    where: {
      slotsOfAppointment: {
        some: {
          startsAt: {
            in: slots.map((s) => parseISO(s.slotStartTimeInUTC)),
          },
        },
      },
    },
    include: {
      slotsOfAppointment: {
        select: {
          startsAt: true,
        },
      },
    },
  });

  const bookedSlotTimes = appointments.flatMap((a) =>
    a.slotsOfAppointment.map((slot) =>
      formatInTimeZone(slot.startsAt, "UTC", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
    ),
  );

  return slots.filter(
    (slot) => !bookedSlotTimes.includes(slot.slotStartTimeInUTC),
  );
}

/**
 * Filters out slots that have already passed or are within the minimum booking lead time.
 * Users cannot book slots that start within MINIMUM_BOOKING_LEAD_TIME_MINUTES of now.
 */
function filterExpiredSlots(slots: TSlotTiming[]): TSlotTiming[] {
  const minimumBookingTime = new Date(Date.now() + MINIMUM_BOOKING_LEAD_TIME_MS);

  return slots.filter((slot) => {
    const slotStart = parseISO(slot.slotStartTimeInUTC);
    return slotStart >= minimumBookingTime;
  });
}

function getDayOfWeek(date: Date): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY,
  ];
  return days[date.getDay()];
}

function getPreviousDayOfWeek(day: DayOfWeek): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY,
  ];
  const index = days.indexOf(day);
  return days[(index - 1 + 7) % 7];
}

function setToUserDate(date: Date, userDate: Date): Date {
  const result = new Date(date);
  result.setFullYear(
    userDate.getFullYear(),
    userDate.getMonth(),
    userDate.getDate(),
  );
  return result;
}

function mapWeeklySlotToTiming(
  slot: {
    id: string;
    availabilityStartsAt: Date;
    availabilityEndsAt: Date;
    dayOfWeekForStartsAt: DayOfWeek;
    dayOfWeekForEndsAt: DayOfWeek;
  },
  userDate: Date,
  userTimeZone: string,
): TSlotTiming {
  const slotStart = toZonedTime(slot.availabilityStartsAt, userTimeZone);
  const slotEnd = toZonedTime(slot.availabilityEndsAt, userTimeZone);
  const adjustedStart = setToUserDate(slotStart, userDate);
  const adjustedEnd = setToUserDate(slotEnd, userDate);

  if (slot.dayOfWeekForStartsAt !== slot.dayOfWeekForEndsAt) {
    adjustedEnd.setDate(adjustedEnd.getDate() + 1);
  }

  return {
    slotId: slot.id,
    dateInISO: formatInTimeZone(
      adjustedStart,
      userTimeZone,
      "yyyy-MM-dd'T'HH:mm:ssXXX",
    ),
    dayOfWeek: slot.dayOfWeekForStartsAt,
    slotStartTimeInUTC: formatInTimeZone(
      fromZonedTime(adjustedStart, userTimeZone),
      "UTC",
      "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    ),
    slotEndTimeInUTC: formatInTimeZone(
      fromZonedTime(adjustedEnd, userTimeZone),
      "UTC",
      "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    ),
    slotOfAvailabilityId: slot.id,
    slotOfAppointmentId: "",
    localStartTime: formatInTimeZone(adjustedStart, userTimeZone, "HH:mm"),
    localEndTime: formatInTimeZone(adjustedEnd, userTimeZone, "HH:mm"),
    type: "WEEKLY" as const,
  };
}

function mapCustomSlotToTiming(
  slot: {
    id: string;
    availabilityStartsAt: Date;
    availabilityEndsAt: Date;
  },
  userTimeZone: string,
): TSlotTiming {
  const slotStart = toZonedTime(slot.availabilityStartsAt, userTimeZone);
  const slotEnd = toZonedTime(slot.availabilityEndsAt, userTimeZone);

  // Get the day of week for the slot's start time
  const dayOfWeek = getDayOfWeek(slotStart);

  return {
    slotId: slot.id,
    dateInISO: formatInTimeZone(
      slotStart,
      userTimeZone,
      "yyyy-MM-dd'T'HH:mm:ssXXX",
    ),
    dayOfWeek,
    slotStartTimeInUTC: formatInTimeZone(
      slot.availabilityStartsAt,
      "UTC",
      "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    ),
    slotEndTimeInUTC: formatInTimeZone(
      slot.availabilityEndsAt,
      "UTC",
      "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    ),
    slotOfAvailabilityId: slot.id,
    slotOfAppointmentId: "",
    localStartTime: formatInTimeZone(slotStart, userTimeZone, "HH:mm"),
    localEndTime: formatInTimeZone(slotEnd, userTimeZone, "HH:mm"),
    // Added type field to satisfy TSlotTiming interface requirements
    // This field distinguishes between "WEEKLY" and "CUSTOM" slot types for filtering
    type: "CUSTOM" as const,
  };
}
