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

    // FIX Bug #08: Scope appointment query to the specific consultant
    // Without this filter, appointments from other consultants could incorrectly
    // mark this consultant's slots as allocated.
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: [
          {
            consultation: {
              consultationPlan: { consultantProfileId },
            },
          },
          {
            subscription: {
              subscriptionPlan: { consultantProfileId },
            },
          },
          {
            webinar: {
              webinarPlan: { consultantProfileId },
            },
          },
          {
            class: {
              classPlan: { consultantProfileId },
            },
          },
        ],
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

    // FIX Bug #09: Use range overlap check instead of exact key matching
    const unallocatedSlots = customSlots.filter((slot) => {
      const hasOverlap = allocatedSlots.some(
        (allocated) =>
          allocated.startsAt < slot.availabilityEndsAt &&
          allocated.endsAt > slot.availabilityStartsAt,
      );
      return !hasOverlap;
    });

    // FIX Bug #20: Recompute total after filtering to reflect actual unallocated count
    // `total` is the count of all configured custom slots (before filtering out allocated ones)
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
    console.error("Error fetching unallocated custom slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching unallocated custom slots" },
      { status: 500 },
    );
  }
}
