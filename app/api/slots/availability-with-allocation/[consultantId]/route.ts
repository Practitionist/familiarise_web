import prisma from "@/lib/prisma";
import { TSlotTiming } from "@/types/slots";
import { NextRequest, NextResponse } from "next/server";
import {
  processAvailabilitySlots,
  WeeklySlot,
  CustomSlot,
  AppointmentSlot,
} from "@/lib/slotUtils";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;
    const { searchParams } = new URL(req.url);
    const startDateInUtc = searchParams.get("startDateInUtc");
    const endDateInUtc = searchParams.get("endDateInUtc");
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
            slotStartTimeInUTC: { gte: startDate },
            slotEndTimeInUTC: { lte: endDate },
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
    const appointments = await prisma.appointment.findMany({
      where: {
        OR: [
          { consultation: { consultationPlan: { consultantProfileId: consultantId } } },
          { subscription: { subscriptionPlan: { consultantProfileId: consultantId } } },
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

    // Extract appointment slots
    const appointmentSlots: AppointmentSlot[] = [];
    appointments.forEach((appt) => {
      appt.slotsOfAppointment.forEach((slot) => {
        appointmentSlots.push({
          slotStartTimeInUTC: slot.slotStartTimeInUTC,
          slotEndTimeInUTC: slot.slotEndTimeInUTC,
        });
      });
    });

    // Convert to utility interfaces
    const weeklySlots: WeeklySlot[] = consultant.slotsOfAvailabilityWeekly.map((slot) => ({
      id: slot.id,
      dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
      slotStartTimeInUTC: slot.slotStartTimeInUTC,
      dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
      slotEndTimeInUTC: slot.slotEndTimeInUTC,
    }));

    const customSlots: CustomSlot[] = consultant.slotsOfAvailabilityCustom.map((slot) => ({
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
      { status: 500 },
    );
  }
}

