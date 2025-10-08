/**
 * Webinar Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService
 * Reduced from 302 lines to ~90 lines
 */

import prisma from "@/lib/prisma";
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

const webinarInclude = {
  webinarPlan: {
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
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  try {
    const { webinarId } = await params;
    const body: ValidationRequest = await request.json();

    // Fetch webinar with necessary relations
    const webinar = await prisma.webinar.findUnique({
      where: { id: webinarId },
      include: webinarInclude,
    });

    if (!webinar) {
      return NextResponse.json({ error: "Webinar not found" }, { status: 404 });
    }

    const { webinarPlan } = webinar;
    const { consultantProfile } = webinarPlan;

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
      "webinar",
      webinarId,
      slotDates,
      {
        userId: consultantProfile.user.id,
        scheduleType: consultantProfile.scheduleType,
        slotsOfAvailabilityWeekly: consultantProfile.slotsOfAvailabilityWeekly,
        slotsOfAvailabilityCustom: consultantProfile.slotsOfAvailabilityCustom,
        currentTimezone: consultantProfile.user.currentTimezone || undefined,
      },
      {
        durationInHours: webinarPlan.durationInHours || 1,
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
        const slotMatch = error.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        if (slotMatch) {
          const slot = slotMatch[1];
          result.conflicts.push({
            slot,
            existingAppointment: {
              type: error.includes("Subscription")
                ? "Subscription"
                : error.includes("Webinar")
                  ? "Webinar"
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
    console.error("Webinar validation error:", error);
    return NextResponse.json(
      { error: "Failed to validate webinar slot" },
      { status: 500 },
    );
  }
}
