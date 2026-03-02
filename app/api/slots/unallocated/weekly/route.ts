import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";
import { buildOccupiedAppointmentFilter } from "@/utils/slotAllocation/occupancyPolicy";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const startDateInUtc = searchParams.get("startDateInUtc");
    const endDateInUtc = searchParams.get("endDateInUtc");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "consultantProfileId is required" },
        { status: 400 },
      );
    }

    if (!startDateInUtc || !endDateInUtc) {
      return NextResponse.json(
        { error: "startDateInUtc and endDateInUtc are required" },
        { status: 400 },
      );
    }

    // Get all occupied appointments for this consultant (all event types + trials)
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: buildOccupiedAppointmentFilter(consultantProfileId),
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

    // Fetch ALL weekly slots (no DB-level pagination) so we can filter out
    // allocated ones first, then paginate the filtered results accurately.
    const allWeeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
      where: {
        consultantProfileId,
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
    });

    // For weekly slots, check if any instance in the date range overlaps an allocated slot.
    // FIX Bug #09: Use range overlap check instead of exact key matching,
    // and use UTC-consistent date construction instead of local setHours/setMinutes.
    // Weekly slots now use Int (minutes since midnight UTC) instead of DateTime.
    const allUnallocatedSlots = allWeeklySlots.filter((slot) => {
      const startDate = new Date(startDateInUtc);
      const endDate = new Date(endDateInUtc);
      const currentDate = new Date(startDate);

      const startHours = Math.floor(slot.startTimeUtc / 60);
      const startMins = slot.startTimeUtc % 60;
      const endHours = Math.floor(slot.endTimeUtc / 60);
      const endMins = slot.endTimeUtc % 60;

      while (currentDate <= endDate) {
        if (
          currentDate.getUTCDay() === dayToNumber[slot.startDay]
        ) {
          // Use UTC-consistent construction with Int minutes
          const slotStart = new Date(
            Date.UTC(
              currentDate.getUTCFullYear(),
              currentDate.getUTCMonth(),
              currentDate.getUTCDate(),
              startHours,
              startMins,
              0,
              0,
            ),
          );

          const slotEnd = new Date(
            Date.UTC(
              currentDate.getUTCFullYear(),
              currentDate.getUTCMonth(),
              currentDate.getUTCDate(),
              endHours,
              endMins,
              0,
              0,
            ),
          );

          // Check for any overlapping allocated slot (partial or full overlap)
          const hasOverlap = allocatedSlots.some(
            (allocated) =>
              allocated.startsAt < slotEnd && allocated.endsAt > slotStart,
          );
          if (hasOverlap) {
            return false;
          }
        }

        // Move to next day
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }
      return true; // Slot is available if no conflicts found
    });

    // Apply pagination in memory after filtering so totals are accurate
    const totalConfigured = allWeeklySlots.length;
    const totalUnallocated = allUnallocatedSlots.length;
    const paginatedSlots = allUnallocatedSlots.slice(
      (page - 1) * limit,
      page * limit,
    );

    return NextResponse.json(
      {
        data: paginatedSlots,
        meta: {
          totalUnallocated,
          totalConfigured,
          page,
          limit,
          totalPages: Math.ceil(totalUnallocated / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching unallocated weekly slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching unallocated weekly slots" },
      { status: 500 },
    );
  }
}

// Helper to convert DayOfWeek enum to number (0-6)
const dayToNumber: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};
