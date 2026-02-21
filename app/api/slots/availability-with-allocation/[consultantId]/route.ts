import prisma from "@/lib/prisma";
import {
  AppointmentSlot,
  CustomSlot,
  processAvailabilitySlots,
  WeeklySlot,
} from "@/utils/timeSlotsProcessing";
import { NextRequest, NextResponse } from "next/server";
import { buildOccupiedAppointmentFilter } from "@/utils/slotAllocation/occupancyPolicy";

// Helper function to check if a slot is a legitimate overnight slot
function isValidOvernightSlot(startTime: Date, endTime: Date): boolean {
  // For normal slots where end > start, they are always valid
  if (endTime > startTime) {
    return true;
  }

  // For slots where end <= start, check if they are legitimate overnight slots
  if (endTime <= startTime) {
    // Check if this is a midnight-ending slot (ends at 00:00)
    const endHours = endTime.getUTCHours();
    const endMinutes = endTime.getUTCMinutes();
    const endSeconds = endTime.getUTCSeconds();

    // If it ends at exactly midnight (00:00:00), it's a valid midnight-ending slot
    if (endHours === 0 && endMinutes === 0 && endSeconds === 0) {
      return true;
    }

    // Check if end date is actually the next day (true overnight slot)
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    startDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCHours(0, 0, 0, 0);

    // If end date is the day after start date, it's a valid overnight slot
    const dayDifference =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    return dayDifference === 1;
  }

  return false; // Invalid slot
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;
    const { searchParams } = new URL(req.url);

    // Support both old and new parameter names for backward compatibility
    const startDateInUtc =
      searchParams.get("startDateInUtc") || searchParams.get("startDate");
    const endDateInUtc =
      searchParams.get("endDateInUtc") || searchParams.get("endDate");
    const timezone = searchParams.get("timezone") || "UTC";

    if (!startDateInUtc || !endDateInUtc) {
      return NextResponse.json(
        { error: "startDateInUtc and endDateInUtc are required" },
        { status: 400 },
      );
    }

    // Validate dates
    let startDate: Date, endDate: Date;
    try {
      startDate = new Date(startDateInUtc);
      endDate = new Date(endDateInUtc);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw new Error("Invalid date format");
      }
    } catch (error) {
      return NextResponse.json(
        { error: "Dates must be in UTC ISO format" },
        { status: 400 },
      );
    }

    // 1. Fetch consultant's availability
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      include: {
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: {
          where: {
            // Use comprehensive overlap check for custom slots to match appointment logic
            OR: [
              {
                availabilityStartsAt: {
                  gte: startDate,
                  lt: endDate,
                },
              },
              {
                availabilityEndsAt: {
                  gt: startDate,
                  lte: endDate,
                },
              },
              {
                availabilityStartsAt: { lte: startDate },
                availabilityEndsAt: { gte: endDate },
              },
            ],
          },
        },
      },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // 2. Fetch all appointments to find allocated slots
    // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: buildOccupiedAppointmentFilter(consultantId),
        slotsOfAppointment: {
          some: {
            OR: [
              {
                startsAt: {
                  gte: startDate,
                  lt: endDate,
                },
              },
              {
                endsAt: {
                  gt: startDate,
                  lte: endDate,
                },
              },
              {
                startsAt: { lte: startDate },
                endsAt: { gte: endDate },
              },
            ],
          },
        },
      },
      include: {
        slotsOfAppointment: true,
      },
    });

    // Extract appointment slots using flatMap with defensive filtering
    // Defensive Programming: Filter out corrupt appointment slots
    const appointmentSlots: AppointmentSlot[] = appointments.flatMap((appt) =>
      appt.slotsOfAppointment
        .filter((slot) => {
          // Validate slot has required fields
          if (!slot.startsAt || !slot.endsAt) {
            console.warn(
              `⚠️ Skipping appointment slot ${slot.id}: missing start or end time`,
            );
            return false;
          }

          // Validate slot times are valid dates
          const start = new Date(slot.startsAt);
          const end = new Date(slot.endsAt);
          if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            console.warn(
              `⚠️ Skipping appointment slot ${slot.id}: invalid date format`,
            );
            return false;
          }

          // Filter out invalid appointment slots (allow legitimate overnight slots)
          if (!isValidOvernightSlot(start, end)) {
            console.warn(
              `⚠️ Skipping appointment slot ${slot.id}: end time ${end.toISOString()} <= start time ${start.toISOString()} (not a valid overnight slot)`,
            );
            return false;
          }

          // Defensive: Filter out slots that are unreasonably far in the past (>10 years)
          // This likely indicates data corruption
          const tenYearsAgo = new Date();
          tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
          if (end < tenYearsAgo) {
            console.warn(
              `⚠️ Skipping appointment slot ${slot.id}: end time is more than 10 years in the past (${end.toISOString()}) - possible data corruption`,
            );
            return false;
          }

          // Defensive: Filter out slots that are unreasonably far in the future (>10 years)
          // This likely indicates data corruption
          const tenYearsFromNow = new Date();
          tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);
          if (start > tenYearsFromNow) {
            console.warn(
              `⚠️ Skipping appointment slot ${slot.id}: start time is more than 10 years in the future (${start.toISOString()}) - possible data corruption`,
            );
            return false;
          }

          // Defensive: Filter out slots with duration > 24 hours (likely data corruption)
          const durationHours =
            (end.getTime() - start.getTime()) / (1000 * 60 * 60);
          if (durationHours > 24) {
            console.warn(
              `⚠️ Skipping appointment slot ${slot.id}: duration is > 24 hours (${durationHours.toFixed(1)}h) - possible data corruption`,
            );
            return false;
          }

          return true;
        })
        .map((slot) => ({
          slotStartTimeInUTC: slot.startsAt,
          slotEndTimeInUTC: slot.endsAt,
        })),
    );

    // Convert to utility interfaces with defensive validation
    const weeklySlots: WeeklySlot[] = consultant.slotsOfAvailabilityWeekly
      .filter((slot) => {
        // Defensive: Validate required fields exist
        if (
          !slot.availabilityStartsAt ||
          !slot.availabilityEndsAt ||
          !slot.dayOfWeekForStartsAt
        ) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: missing required fields`,
          );
          return false;
        }

        // Defensive: Validate dates are valid
        const start = new Date(slot.availabilityStartsAt);
        const end = new Date(slot.availabilityEndsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: invalid date format`,
          );
          return false;
        }

        // Filter out invalid slots, but allow legitimate overnight slots
        if (
          !isValidOvernightSlot(
            slot.availabilityStartsAt,
            slot.availabilityEndsAt,
          )
        ) {
          console.warn(
            `❌ Filtering out invalid weekly slot ${slot.id}: end time ${slot.availabilityEndsAt.toISOString()} <= start time ${slot.availabilityStartsAt.toISOString()}`,
          );
          return false;
        }

        // Defensive: Check duration is reasonable (<= 24 hours)
        const durationHours =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours > 24) {
          console.warn(
            `⚠️ Filtering out weekly slot ${slot.id}: duration > 24 hours (${durationHours.toFixed(1)}h)`,
          );
          return false;
        }

        return true;
      })
      .map((slot) => ({
        id: slot.id,
        dayOfWeekforStartTimeInUTC: slot.dayOfWeekForStartsAt,
        slotStartTimeInUTC: slot.availabilityStartsAt,
        dayOfWeekforEndTimeInUTC: slot.dayOfWeekForEndsAt,
        slotEndTimeInUTC: slot.availabilityEndsAt,
      }));

    const customSlots: CustomSlot[] = consultant.slotsOfAvailabilityCustom
      .filter((slot) => {
        // Defensive: Validate required fields exist
        if (!slot.availabilityStartsAt || !slot.availabilityEndsAt) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: missing required fields`,
          );
          return false;
        }

        // Defensive: Validate dates are valid
        const start = new Date(slot.availabilityStartsAt);
        const end = new Date(slot.availabilityEndsAt);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: invalid date format`,
          );
          return false;
        }

        // Filter out invalid slots, but allow legitimate overnight slots
        if (
          !isValidOvernightSlot(
            slot.availabilityStartsAt,
            slot.availabilityEndsAt,
          )
        ) {
          console.warn(
            `❌ Filtering out invalid custom slot ${slot.id}: end time ${slot.availabilityEndsAt.toISOString()} <= start time ${slot.availabilityStartsAt.toISOString()}`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the past (>10 years)
        const tenYearsAgo = new Date();
        tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
        if (end < tenYearsAgo) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: end time is more than 10 years in the past (${end.toISOString()})`,
          );
          return false;
        }

        // Defensive: Filter out slots that are unreasonably far in the future (>10 years)
        const tenYearsFromNow = new Date();
        tenYearsFromNow.setFullYear(tenYearsFromNow.getFullYear() + 10);
        if (start > tenYearsFromNow) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: start time is more than 10 years in the future (${start.toISOString()})`,
          );
          return false;
        }

        // Defensive: Check duration is reasonable (<= 24 hours)
        const durationHours =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (durationHours > 24) {
          console.warn(
            `⚠️ Filtering out custom slot ${slot.id}: duration > 24 hours (${durationHours.toFixed(1)}h)`,
          );
          return false;
        }

        return true;
      })
      .map((slot) => ({
        id: slot.id,
        slotStartTimeInUTC: slot.availabilityStartsAt,
        slotEndTimeInUTC: slot.availabilityEndsAt,
      }));

    // Apply schedule type filtering based on consultant's preference
    const filteredWeeklySlots =
      consultant.scheduleType === "WEEKLY" ? weeklySlots : [];
    const filteredCustomSlots =
      consultant.scheduleType === "CUSTOM" ? customSlots : [];

    // Process slots using the unified utility with filtered slots
    const slotsByDate = processAvailabilitySlots(
      filteredWeeklySlots,
      filteredCustomSlots,
      appointmentSlots,
      startDate,
      endDate,
      timezone,
    );

    return NextResponse.json({ data: slotsByDate }, { status: 200 });
  } catch (error) {
    console.error("Error fetching availability slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching availability slots" },
      { status: 500 },
    );
  }
}
