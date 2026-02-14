import prisma from "@/lib/prisma";
import { TSlotTiming } from "@/types/slots";
import { DayOfWeek } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;
    const { searchParams } = new URL(req.url);
    const startDateInUtc = searchParams.get("startDateInUtc");
    const endDateInUtc = searchParams.get("endDateInUtc");

    if (!startDateInUtc || !endDateInUtc) {
      return NextResponse.json(
        { error: "startDateInUtc and endDateInUtc are required" },
        { status: 400 },
      );
    }

    // Validate dates are in UTC
    try {
      const start = new Date(startDateInUtc);
      const end = new Date(endDateInUtc);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error("Invalid date format");
      }
    } catch (error) {
      return NextResponse.json(
        { error: "Dates must be in UTC ISO format" },
        { status: 400 },
      );
    }

    // Get all appointments that overlap with the requested time period
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: [
          {
            consultation: {
              consultationPlan: {
                consultantProfileId: consultantId,
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfileId: consultantId,
              },
            },
          },
        ],
        slotsOfAppointment: {
          some: {
            OR: [
              {
                startsAt: {
                  gte: new Date(startDateInUtc),
                  lte: new Date(endDateInUtc),
                },
              },
              {
                endsAt: {
                  gte: new Date(startDateInUtc),
                  lte: new Date(endDateInUtc),
                },
              },
            ],
          },
        },
      },
      include: {
        slotsOfAppointment: true,
      },
    });

    // FIX Bug #09: Store allocated slots as array for range overlap checks
    // instead of exact key matching which misses partial overlaps
    const allocatedSlots: { startsAt: Date; endsAt: Date }[] = [];
    appointments.forEach((appointment) => {
      appointment.slotsOfAppointment.forEach((slot) => {
        allocatedSlots.push({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
        });
      });
    });

    // Get custom slots
    const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
      where: {
        consultantProfileId: consultantId,
        availabilityStartsAt: { gte: new Date(startDateInUtc) },
        availabilityEndsAt: { lte: new Date(endDateInUtc) },
      },
      orderBy: {
        availabilityStartsAt: "asc",
      },
    });

    // Get weekly slots
    const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
      where: {
        consultantProfileId: consultantId,
      },
      orderBy: [
        { dayOfWeekForStartsAt: "asc" },
        { availabilityStartsAt: "asc" },
      ],
    });

    // FIX Bug #09: Use range overlap check instead of exact key matching
    const unallocatedCustomSlots = customSlots.filter((slot) => {
      const hasOverlap = allocatedSlots.some(
        (allocated) =>
          allocated.startsAt < slot.availabilityEndsAt &&
          allocated.endsAt > slot.availabilityStartsAt,
      );
      return !hasOverlap;
    });

    // For weekly slots, generate instances for the date range and filter out allocated ones
    const unallocatedWeeklySlots: TSlotTiming[] = [];
    const start = new Date(startDateInUtc);
    const end = new Date(endDateInUtc);

    // FIX Bug #09: Use UTC-consistent date construction and range overlap check
    weeklySlots.forEach((weeklySlot) => {
      const currentDate = new Date(start);

      while (currentDate <= end) {
        if (
          currentDate.getUTCDay() ===
          dayToNumber[weeklySlot.dayOfWeekForStartsAt]
        ) {
          // Use UTC-consistent construction to avoid timezone drift
          const slotStart = new Date(
            Date.UTC(
              currentDate.getUTCFullYear(),
              currentDate.getUTCMonth(),
              currentDate.getUTCDate(),
              weeklySlot.availabilityStartsAt.getUTCHours(),
              weeklySlot.availabilityStartsAt.getUTCMinutes(),
              0,
              0,
            ),
          );

          const slotEnd = new Date(
            Date.UTC(
              currentDate.getUTCFullYear(),
              currentDate.getUTCMonth(),
              currentDate.getUTCDate(),
              weeklySlot.availabilityEndsAt.getUTCHours(),
              weeklySlot.availabilityEndsAt.getUTCMinutes(),
              0,
              0,
            ),
          );

          // Check for any overlapping allocated slot (partial or full overlap)
          const hasOverlap = allocatedSlots.some(
            (allocated) =>
              allocated.startsAt < slotEnd && allocated.endsAt > slotStart,
          );
          if (!hasOverlap) {
            unallocatedWeeklySlots.push({
              slotId: weeklySlot.id,
              dateInISO: currentDate.toISOString(),
              dayOfWeek: weeklySlot.dayOfWeekForStartsAt,
              slotStartTimeInUTC: slotStart.toISOString(),
              slotEndTimeInUTC: slotEnd.toISOString(),
              slotOfAvailabilityId: weeklySlot.id,
              slotOfAppointmentId: "",
              localStartTime: slotStart.toLocaleTimeString(),
              localEndTime: slotEnd.toLocaleTimeString(),
              type: "WEEKLY" as const,
            });
          }
        }

        // Move to next day
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }
    });

    // Convert custom slots to TSlotTiming format
    const formattedCustomSlots: TSlotTiming[] = unallocatedCustomSlots.map(
      (slot) => ({
        slotId: slot.id,
        dateInISO: slot.availabilityStartsAt.toISOString(),
        dayOfWeek: dayMap[new Date(slot.availabilityStartsAt).getDay()],
        slotStartTimeInUTC: slot.availabilityStartsAt.toISOString(),
        slotEndTimeInUTC: slot.availabilityEndsAt.toISOString(),
        slotOfAvailabilityId: slot.id,
        slotOfAppointmentId: "",
        localStartTime: new Date(
          slot.availabilityStartsAt,
        ).toLocaleTimeString(),
        localEndTime: new Date(slot.availabilityEndsAt).toLocaleTimeString(),
        type: "CUSTOM" as const,
      }),
    );

    // Combine and sort all slots by start time
    const allSlots = [...formattedCustomSlots, ...unallocatedWeeklySlots].sort(
      (a, b) =>
        new Date(a.slotStartTimeInUTC).getTime() -
        new Date(b.slotStartTimeInUTC).getTime(),
    );

    return NextResponse.json({ data: allSlots }, { status: 200 });
  } catch (error) {
    console.error("Error fetching unallocated slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching unallocated slots" },
      { status: 500 },
    );
  }
}

// Helper to convert day number to DayOfWeek enum
const dayMap: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

// Helper to convert DayOfWeek enum to number
const dayToNumber: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};
