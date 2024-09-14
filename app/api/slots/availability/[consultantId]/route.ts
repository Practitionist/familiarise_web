/**
 * This file defines the API route for fetching availability slots for a consultant.
 * It handles GET requests to retrieve available time slots for a specific consultant on a given date,
 * taking into account the user's timezone and the consultant's schedule type (weekly or custom).
 */

import { TSlotTiming } from "@/lib/datetimetz";
import prisma from "@/lib/prisma";
import { DayOfWeek, ScheduleType } from "@prisma/client";
import { endOfDay, parseISO, startOfDay } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { NextRequest, NextResponse } from "next/server";

/**
 * GET handler for fetching availability slots
 * 
 * @param req - The incoming request object
 * @param params - Object containing route parameters
 * @param params.consultantId - The ID of the consultant
 * @returns A JSON response with the available slots or an error message
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { consultantId: string } }
) {
  try {
    const date = req.nextUrl.searchParams.get('date');
    const userTimeZone = req.nextUrl.searchParams.get('timeZone');

    if (!params.consultantId || !date || !userTimeZone) {
      return NextResponse.json(
        { error: "Consultant ID, date, and timezone are required" },
        { status: 400 }
      );
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: params.consultantId },
      select: { scheduleType: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 }
      );
    }

    // Parse the input date in the user's timezone
    const userDate = toZonedTime(parseISO(date), userTimeZone);
    const userDayStart = startOfDay(userDate);
    const userDayEnd = endOfDay(userDate);

    // Convert user's day start and end to UTC
    const utcDayStart = fromZonedTime(userDayStart, userTimeZone);
    const utcDayEnd = fromZonedTime(userDayEnd, userTimeZone);

    let slots: TSlotTiming[] = [];

    if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
      const userDayOfWeek = getDayOfWeek(userDate);
      const previousDayOfWeek = getPreviousDayOfWeek(userDayOfWeek);

      // Fetch slots for the current day and previous day (for overnight slots)
      const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
        where: {
          consultantProfileId: params.consultantId,
          OR: [
            { dayOfWeekforStartTimeInUTC: userDayOfWeek },
            {
              dayOfWeekforStartTimeInUTC: previousDayOfWeek,
              dayOfWeekforEndTimeInUTC: userDayOfWeek,
            },
          ],
        },
        orderBy: { slotStartTimeInUTC: "asc" },
      });

      // Process weekly slots
      slots = weeklySlots.map((slot) => {
        const slotStart = toZonedTime(slot.slotStartTimeInUTC, userTimeZone);
        const slotEnd = toZonedTime(slot.slotEndTimeInUTC, userTimeZone);

        // Adjust dates for the specific day of the week
        const adjustedStart = setToUserDate(slotStart, userDate);
        const adjustedEnd = setToUserDate(slotEnd, userDate);

        if (slot.dayOfWeekforStartTimeInUTC !== slot.dayOfWeekforEndTimeInUTC) {
          // Handle overnight slots
          adjustedEnd.setDate(adjustedEnd.getDate() + 1);
        }

        return {
          slotId: slot.id,
          dateInISO: formatInTimeZone(adjustedStart, userTimeZone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
          slotStartTimeInUTC: formatInTimeZone(fromZonedTime(adjustedStart, userTimeZone), 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
          slotEndTimeInUTC: formatInTimeZone(fromZonedTime(adjustedEnd, userTimeZone), 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
          slotOfAvailabilityId: slot.id,
          slotOfAppointmentId: '', // This would be filled if it's a booked appointment
          localStartTime: formatInTimeZone(adjustedStart, userTimeZone, 'HH:mm'),
          localEndTime: formatInTimeZone(adjustedEnd, userTimeZone, 'HH:mm'),
        } as TSlotTiming;
      });

    } else if (consultantProfile.scheduleType === ScheduleType.CUSTOM) {
      const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
        where: {
          consultantProfileId: params.consultantId,
          OR: [
            {
              slotStartTimeInUTC: {
                gte: utcDayStart,
                lt: utcDayEnd,
              },
            },
            {
              slotEndTimeInUTC: {
                gt: utcDayStart,
                lte: utcDayEnd,
              },
            },
          ],
        },
        orderBy: { slotStartTimeInUTC: "asc" },
      });

      // Process custom slots
      slots = customSlots.map((slot) => {
        const slotStart = toZonedTime(slot.slotStartTimeInUTC, userTimeZone);
        const slotEnd = toZonedTime(slot.slotEndTimeInUTC, userTimeZone);

        return {
          slotId: slot.id,
          dateInISO: formatInTimeZone(slotStart, userTimeZone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
          slotStartTimeInUTC: formatInTimeZone(slot.slotStartTimeInUTC, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
          slotEndTimeInUTC: formatInTimeZone(slot.slotEndTimeInUTC, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
          slotOfAvailabilityId: slot.id,
          slotOfAppointmentId: '', // This would be filled if it's a booked appointment
          localStartTime: formatInTimeZone(slotStart, userTimeZone, 'HH:mm'),
          localEndTime: formatInTimeZone(slotEnd, userTimeZone, 'HH:mm'),
        } as TSlotTiming;
      });
    }

    // Filter slots to only include those that overlap with the user's requested day
    slots = slots.filter((slot) => {
      const slotStart = parseISO(slot.dateInISO);
      const slotEnd = parseISO(slot.slotEndTimeInUTC);
      return (slotStart < userDayEnd && slotEnd > userDayStart);
    });

    // Check for existing appointments and remove booked slots
    const appointments = await prisma.appointment.findMany({
      where: {
        slotOfAppointment: {
          OR: [
            { slotOfAvailabilityWeeklyId: { in: slots.map(s => s.slotOfAvailabilityId) } },
            { slotOfAvailabilityCustomId: { in: slots.map(s => s.slotOfAvailabilityId) } },
          ],
        },
      },
      select: {
        slotOfAppointment: {
          select: {
            slotOfAvailabilityWeeklyId: true,
            slotOfAvailabilityCustomId: true,
          },
        },
      },
    });

    const bookedSlotIds = appointments.flatMap(a => {
      if (a.slotOfAppointment) {
        return [
          a.slotOfAppointment.slotOfAvailabilityWeeklyId,
          a.slotOfAppointment.slotOfAvailabilityCustomId
        ].filter((id): id is string => id !== null);
      }
      return [];
    });

    slots = slots.filter(slot => !bookedSlotIds.includes(slot.slotOfAvailabilityId));

    return NextResponse.json(slots, { status: 200 });
  } catch (error) {
    console.error("Error fetching slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching availability slots" },
      { status: 500 }
    );
  }
}

/**
 * Converts a Date object to the corresponding DayOfWeek enum value
 * 
 * @param date - The date to convert
 * @returns The corresponding DayOfWeek enum value
 */
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

/**
 * Gets the previous day of the week
 * 
 * @param day - The current day of the week
 * @returns The previous day of the week
 */
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

/**
 * Sets the year, month, and date of a given date to match another date
 * 
 * @param date - The date to modify
 * @param userDate - The reference date
 * @returns A new Date object with the updated year, month, and date
 */
function setToUserDate(date: Date, userDate: Date): Date {
  const result = new Date(date);
  result.setFullYear(userDate.getFullYear(), userDate.getMonth(), userDate.getDate());
  return result;
}