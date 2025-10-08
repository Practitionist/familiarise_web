/**
 * Consultation Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService
 * Reduced from 200 lines to ~90 lines
 */

import prisma from "@/lib/prisma";
import { RequestStatus, ScheduleType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";

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

const consultationInclude = {
  consultationPlan: {
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
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;
    const body: ValidationRequest = await request.json();

    // Fetch consultation with necessary relations
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: consultationInclude,
    });

    if (!consultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }

    const { consultationPlan, requestedBy } = consultation;
    const { consultantProfile } = consultationPlan;

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 400 },
      );
    }

    // Convert slots to Date objects
    const slotDates = body.slots.map((slot) => new Date(slot));

    // Use unified validation service
    const validationService = new SlotValidationService(prisma);
    const validationResult = await validationService.validate(
      "consultation",
      consultationId,
      slotDates,
      {
        userId: consultantProfile.user.id,
        scheduleType: consultantProfile.scheduleType,
        slotsOfAvailabilityWeekly: consultantProfile.slotsOfAvailabilityWeekly,
        slotsOfAvailabilityCustom: consultantProfile.slotsOfAvailabilityCustom,
        currentTimezone: consultantProfile.user.currentTimezone || undefined,
      },
      {
        durationInHours: consultationPlan.durationInHours,
      },
    );

    // If validation passed, all slots are valid
    if (validationResult.isValid) {
      return NextResponse.json({
        data: {
          conflicts: [],
          outsideAvailability: [],
          validSlots: body.slots,
        },
      });
    }

    // Parse errors to extract conflicts and availability issues
    const result: ValidationResult = {
      conflicts: [],
      outsideAvailability: [],
      validSlots: [],
    };

    for (const error of validationResult.errors) {
      if (
        error.includes("already booked") ||
        error.includes("conflicts with")
      ) {
        // Extract slot time from error message
        const slotMatch = error.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (slotMatch) {
          const slot = slotMatch[1];
          result.conflicts.push({
            slot,
            existingAppointment: {
              type: error.includes("Subscription")
                ? "Subscription"
                : "Consultation",
              with: "Another user",
              time: new Date(slot).toLocaleString(),
            },
          });
        }
      } else if (
        error.includes("does not match") ||
        error.includes("not in consultant's")
      ) {
        // Outside availability
        const slotMatch = error.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (slotMatch) {
          result.outsideAvailability.push({ slot: slotMatch[1] });
        }
      }
    }

    // Valid slots are those not in conflicts or outside availability
    result.validSlots = body.slots.filter((slot) => {
      return (
        !result.conflicts.some((c) => c.slot === slot) &&
        !result.outsideAvailability.some((o) => o.slot === slot)
      );
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("Validation error:", error);
    return NextResponse.json(
      { error: "Failed to validate slots" },
      { status: 500 },
    );
  }
}
