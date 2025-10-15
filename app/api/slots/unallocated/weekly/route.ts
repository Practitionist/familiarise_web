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

    // Create a map of allocated time slots (both confirmed and tentative)
    const allocatedSlots = new Map();
    appointments.forEach((appointment) => {
      appointment.slotsOfAppointment.forEach((slot) => {
        const start = slot.startsAt;
        const end = slot.endsAt;
        allocatedSlots.set(
          `${start.toISOString()}-${end.toISOString()}`,
          slot.isTentative,
        );
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
    // in the next few weeks is already allocated
    const unallocatedSlots = weeklySlots.filter((slot) => {
      // Check slots within the requested date range
      const startDate = new Date(startDateInUtc);
      const endDate = new Date(endDateInUtc);
      const currentDate = new Date(startDate);

      while (currentDate <= endDate) {
        // Check if current date matches the slot's day
        if (currentDate.getDay() === dayToNumber[slot.dayOfWeekForStartsAt]) {
          // Set the time from the slot
          const start = new Date(currentDate);
          start.setHours(slot.availabilityStartsAt.getHours());
          start.setMinutes(slot.availabilityStartsAt.getMinutes());

          const end = new Date(currentDate);
          end.setHours(slot.availabilityEndsAt.getHours());
          end.setMinutes(slot.availabilityEndsAt.getMinutes());

          // Check if this instance is allocated
          const key = `${start.toISOString()}-${end.toISOString()}`;
          if (allocatedSlots.has(key)) {
            return false;
          }
        }

        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
      }
      return true; // Slot is available if no conflicts found
    });

    return NextResponse.json(
      {
        data: unallocatedSlots,
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
