import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";

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
  subscriptionValidation?: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    weeklyInfo: Array<{
      weekStart: Date;
      weekEnd: Date;
      existingCalls: number;
      maxCalls: number;
      canScheduleMore: boolean;
      availableSlots: number;
    }>;
    totalCallsScheduled: number;
    maxTotalCalls: number;
    subscriptionPeriod: {
      start: Date;
      end: Date;
    };
  };
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

    const { subscriptionPlan } = subscription;
    const { consultantProfile } = subscriptionPlan;

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 },
      );
    }

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

    // Add subscription-specific validation
    const validationService = new SubscriptionValidationService(prisma);
    const subscriptionValidation =
      await validationService.validateSubscriptionSlots(
        subscriptionId,
        body.slots,
      );

    result.subscriptionValidation = subscriptionValidation;

    // Mark slots as invalid if they violate subscription rules
    if (!subscriptionValidation.isValid) {
      result.validSlots = result.validSlots.filter((slot) => {
        // Additional filtering based on subscription validation errors
        // For now, if subscription validation fails, no slots are valid
        return false;
      });
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("Validation error:", error);
    return NextResponse.json(
      { error: "Failed to validate slots" },
      { status: 500 },
    );
  }
}
