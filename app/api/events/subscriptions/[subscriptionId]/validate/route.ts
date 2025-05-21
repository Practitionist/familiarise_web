import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

interface ValidationRequest {
  slots: string[];
}

interface ValidationResult {
  conflicts: {
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
    };
  }[];
  outsideAvailability: {
    slot: string;
  }[];
  validSlots: string[];
}

const subscriptionInclude = {
  subscriptionPlan: {
    include: {
      consultantProfile: {
        select: {
          user: true,
          scheduleType: true,
          slotsOfAvailabilityWeekly: true,
          slotsOfAvailabilityCustom: true,
        },
      },
    },
  },
  requestedBy: {
    include: {
      user: true,
    },
  },
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const body: ValidationRequest = await request.json();

    // Fetch subscription with necessary relations
    const subscription = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: subscriptionInclude,
    });

    if (!subscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }

    const { subscriptionPlan, requestedBy } = subscription;
    const { consultantProfile } = subscriptionPlan;

    // Initialize validation result
    const result: ValidationResult = {
      conflicts: [],
      outsideAvailability: [],
      validSlots: [],
    };

    // Convert slots to Date objects
    const slotDates = body.slots.map((slot) => new Date(slot));

    // Check for conflicts with existing appointments
    const existingAppointments = await prisma.appointment.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                subscription: {
                  requestStatus: RequestStatus.APPROVED,
                },
              },
              {
                consultation: {
                  requestStatus: RequestStatus.APPROVED,
                },
              },
            ],
          },
          {
            slotsOfAppointment: {
              some: {
                slotStartTimeInUTC: {
                  in: slotDates,
                },
              },
            },
          },
        ],
      },
      include: {
        subscription: true,
        consultation: true,
        slotsOfAppointment: {
          include: {
            user: true,
          },
        },
      },
    });

    // Process conflicts
    for (const appointment of existingAppointments) {
      const conflictingSlots = appointment.slotsOfAppointment.filter((slot) =>
        slotDates.some(
          (date) =>
            date.toISOString() === slot.slotStartTimeInUTC.toISOString(),
        ),
      );

      for (const slot of conflictingSlots) {
        result.conflicts.push({
          slot: slot.slotStartTimeInUTC.toISOString(),
          existingAppointment: {
            type: appointment.subscription ? "Subscription" : "Consultation",
            with: slot.user[0]?.name || "Unknown",
            time: new Date(slot.slotStartTimeInUTC).toLocaleString(),
          },
        });
      }
    }

    // Check for slots outside availability
    const availableSlots =
      consultantProfile.scheduleType === ScheduleType.WEEKLY
        ? consultantProfile.slotsOfAvailabilityWeekly
        : consultantProfile.slotsOfAvailabilityCustom;

    for (const slotDate of slotDates) {
      let isAvailable = false;

      if (consultantProfile.scheduleType === ScheduleType.WEEKLY) {
        // For weekly schedule, check if the slot matches any weekly pattern
        isAvailable = availableSlots.some((slot) => {
          const slotTime = new Date(slot.slotStartTimeInUTC);
          return (
            slotDate.getDay() === slotTime.getDay() &&
            slotDate.getHours() === slotTime.getHours() &&
            slotDate.getMinutes() === slotTime.getMinutes()
          );
        });
      } else {
        // For custom schedule, check if the slot exists exactly
        isAvailable = availableSlots.some(
          (slot) =>
            new Date(slot.slotStartTimeInUTC).toISOString() ===
            slotDate.toISOString(),
        );
      }

      if (!isAvailable) {
        result.outsideAvailability.push({
          slot: slotDate.toISOString(),
        });
      }
    }

    // Valid slots are those without conflicts and within availability
    result.validSlots = slotDates
      .filter((date) => {
        const dateStr = date.toISOString();
        return (
          !result.conflicts.some((c) => c.slot === dateStr) &&
          !result.outsideAvailability.some((o) => o.slot === dateStr)
        );
      })
      .map((date) => date.toISOString());

    return NextResponse.json({ data: result });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Validation error:", error);
    return NextResponse.json(
      { error: "Failed to validate slots" },
      { status: 500 },
    );
  }
}
