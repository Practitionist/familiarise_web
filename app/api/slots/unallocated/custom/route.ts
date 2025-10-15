import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

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

    // First get all appointments that overlap with the requested time period
    const appointments = await prisma.appointment.findMany({
      where: {
        slotsOfAppointment: {
          some: {
            OR: [
              {
                startsAt: {
                  gte: startDateInUtc ? new Date(startDateInUtc) : undefined,
                  lte: endDateInUtc ? new Date(endDateInUtc) : undefined,
                },
              },
              {
                endsAt: {
                  gte: startDateInUtc ? new Date(startDateInUtc) : undefined,
                  lte: endDateInUtc ? new Date(endDateInUtc) : undefined,
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

    // Get all custom slots for the consultant
    const [customSlots, total] = await Promise.all([
      prisma.slotOfAvailabilityCustom.findMany({
        where: {
          consultantProfileId,
          ...(startDateInUtc && endDateInUtc
            ? {
                availabilityStartsAt: { gte: new Date(startDateInUtc) },
                availabilityEndsAt: { lte: new Date(endDateInUtc) },
              }
            : {}),
        },
        orderBy: {
          availabilityStartsAt: "asc",
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
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.slotOfAvailabilityCustom.count({
        where: {
          consultantProfileId,
          ...(startDateInUtc && endDateInUtc
            ? {
                availabilityStartsAt: { gte: new Date(startDateInUtc) },
                availabilityEndsAt: { lte: new Date(endDateInUtc) },
              }
            : {}),
        },
      }),
    ]);

    // Filter out allocated slots
    const unallocatedSlots = customSlots.filter((slot) => {
      const key = `${slot.availabilityStartsAt.toISOString()}-${slot.availabilityEndsAt.toISOString()}`;
      return !allocatedSlots.has(key);
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
    console.error("Error fetching unallocated custom slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching unallocated custom slots" },
      { status: 500 },
    );
  }
}
