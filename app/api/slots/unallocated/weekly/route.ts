import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";

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

    // Get all appointments for this consultant
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: [
          {
            consultation: {
              consultationPlan: {
                consultantProfileId,
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfileId,
              },
            },
          },
        ],
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

    // Get all weekly slots for the consultant
    const [weeklySlots, total] = await Promise.all([
      prisma.slotOfAvailabilityWeekly.findMany({
        where: {
          consultantProfileId,
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
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.slotOfAvailabilityWeekly.count({
        where: { consultantProfileId },
      }),
    ]);

    // For weekly slots, we need to check if any instance of the weekly slot
    // in the date range is already allocated
    // FIX Bug #09: Use range overlap check instead of exact key matching,
    // and use UTC-consistent date construction instead of local setHours/setMinutes
    const unallocatedSlots = weeklySlots.filter((slot) => {
      const startDate = new Date(startDateInUtc);
      const endDate = new Date(endDateInUtc);
      const currentDate = new Date(startDate);

      while (currentDate <= endDate) {
        if (currentDate.getUTCDay() === dayToNumber[slot.dayOfWeekForStartsAt]) {
          // Use UTC-consistent construction to avoid timezone drift
          const slotStart = new Date(
            Date.UTC(
              currentDate.getUTCFullYear(),
              currentDate.getUTCMonth(),
              currentDate.getUTCDate(),
              slot.availabilityStartsAt.getUTCHours(),
              slot.availabilityStartsAt.getUTCMinutes(),
              0,
              0,
            ),
          );

          const slotEnd = new Date(
            Date.UTC(
              currentDate.getUTCFullYear(),
              currentDate.getUTCMonth(),
              currentDate.getUTCDate(),
              slot.availabilityEndsAt.getUTCHours(),
              slot.availabilityEndsAt.getUTCMinutes(),
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

    // FIX Bug #20: Recompute total after filtering to reflect actual unallocated count
    // `total` is the count of all configured weekly slots (before filtering out allocated ones)
    const totalUnallocated = unallocatedSlots.length;

    return NextResponse.json(
      {
        data: unallocatedSlots,
        meta: {
          totalUnallocated,
          totalConfigured: total,
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
