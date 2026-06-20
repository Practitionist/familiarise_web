import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
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

    // Get all occupied appointments for this consultant (all event types + trials).
    // Use canonical overlap predicate to catch all overlap shapes including enclosing.
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: buildOccupiedAppointmentFilter(consultantProfileId),
        ...(startDateInUtc && endDateInUtc
          ? {
              slotsOfAppointment: {
                some: {
                  startsAt: { lt: new Date(endDateInUtc) },
                  endsAt: { gt: new Date(startDateInUtc) },
                },
              },
            }
          : {}),
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

    // Fetch ALL custom slots (no DB-level pagination) so we can filter out
    // allocated ones first, then paginate the filtered results accurately.
    const dateFilter =
      startDateInUtc && endDateInUtc
        ? {
            startsAt: { gte: new Date(startDateInUtc) },
            endsAt: { lte: new Date(endDateInUtc) },
          }
        : {};

    const allCustomSlots = await prisma.slotOfAvailabilityCustom.findMany({
      where: {
        consultantProfileId,
        ...dateFilter,
      },
      orderBy: {
        startsAt: "asc",
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

    // FIX Bug #09: Use range overlap check instead of exact key matching
    const allUnallocatedSlots = allCustomSlots.filter((slot) => {
      const hasOverlap = allocatedSlots.some(
        (allocated) =>
          allocated.startsAt < slot.endsAt && allocated.endsAt > slot.startsAt,
      );
      return !hasOverlap;
    });

    // Apply pagination in memory after filtering so totals are accurate
    const totalConfigured = allCustomSlots.length;
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
    console.error("Error fetching unallocated custom slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching unallocated custom slots" },
      { status: 500 },
    );
  }
}
