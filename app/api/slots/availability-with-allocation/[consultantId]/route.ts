import prisma from "@/lib/prisma";
import {
  AppointmentSlot,
  CustomSlot,
  processAvailabilitySlots,
  WeeklySlot,
} from "@/utils/timeSlotsProcessing";
import { NextRequest, NextResponse } from "next/server";

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
  { params }: { params: Promise<{ consultantId: string }> }
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
        { status: 400 }
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
        { status: 400 }
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
                slotStartTimeInUTC: {
                  gte: startDate,
                  lt: endDate,
                },
              },
              {
                slotEndTimeInUTC: {
                  gt: startDate,
                  lte: endDate,
                },
              },
              {
                slotStartTimeInUTC: { lte: startDate },
                slotEndTimeInUTC: { gte: endDate },
              },
            ],
          },
        },
      },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 }
      );
    }

    // 2. Fetch all appointments to find allocated slots
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: [
          {
            consultation: {
              consultationPlan: { consultantProfileId: consultantId },
            },
          },
          {
            subscription: {
              subscriptionPlan: { consultantProfileId: consultantId },
            },
          },
          { webinar: { webinarPlan: { consultantProfileId: consultantId } } },
          { class: { classPlan: { consultantProfileId: consultantId } } },
        ],
        slotsOfAppointment: {
          some: {
            OR: [
              {
                slotStartTimeInUTC: {
                  gte: startDate,
                  lt: endDate,
                },
              },
              {
                slotEndTimeInUTC: {
                  gt: startDate,
                  lte: endDate,
                },
              },
              {
                slotStartTimeInUTC: { lte: startDate },
                slotEndTimeInUTC: { gte: endDate },
              },
            ],
          },
        },
      },
      include: {
        slotsOfAppointment: true,
      },
    });

    // Extract appointment slots using flatMap for conciseness
    const appointmentSlots: AppointmentSlot[] = appointments.flatMap((appt) =>
      appt.slotsOfAppointment.map((slot) => ({
        slotStartTimeInUTC: slot.slotStartTimeInUTC,
        slotEndTimeInUTC: slot.slotEndTimeInUTC,
      }))
    );

    // Convert to utility interfaces
    const weeklySlots: WeeklySlot[] = consultant.slotsOfAvailabilityWeekly
      .filter((slot) => {
        // Filter out invalid slots, but allow legitimate overnight slots
        if (
          !isValidOvernightSlot(slot.slotStartTimeInUTC, slot.slotEndTimeInUTC)
        ) {
          console.warn(
            `❌ Filtering out invalid weekly slot ${slot.id}: end time ${slot.slotEndTimeInUTC.toISOString()} <= start time ${slot.slotStartTimeInUTC.toISOString()}`
          );
          return false;
        }
        return true;
      })
      .map((slot) => ({
        id: slot.id,
        dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
        slotStartTimeInUTC: slot.slotStartTimeInUTC,
        dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
        slotEndTimeInUTC: slot.slotEndTimeInUTC,
      }));

    const customSlots: CustomSlot[] = consultant.slotsOfAvailabilityCustom
      .filter((slot) => {
        // Filter out invalid slots, but allow legitimate overnight slots
        if (
          !isValidOvernightSlot(slot.slotStartTimeInUTC, slot.slotEndTimeInUTC)
        ) {
          console.warn(
            `❌ Filtering out invalid custom slot ${slot.id}: end time ${slot.slotEndTimeInUTC.toISOString()} <= start time ${slot.slotStartTimeInUTC.toISOString()}`
          );
          return false;
        }
        return true;
      })
      .map((slot) => ({
        id: slot.id,
        slotStartTimeInUTC: slot.slotStartTimeInUTC,
        slotEndTimeInUTC: slot.slotEndTimeInUTC,
      }));

    // Process all slots using the unified utility
    const slotsByDate = processAvailabilitySlots(
      weeklySlots,
      customSlots,
      appointmentSlots,
      startDate,
      endDate,
      timezone
    );

    return NextResponse.json({ data: slotsByDate }, { status: 200 });
  } catch (error) {
    console.error("Error fetching availability slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching availability slots" },
      { status: 500 }
    );
  }
}
