/**
 * Class Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService
 * Reduced from 304 lines to ~110 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SlotValidationService - Validates business rules (conflicts, availability, weekly distribution, etc.)
 */

import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import {
  validationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";

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
  weeklyDistributionErrors: {
    week: string;
    slotsCount: number;
    maxAllowed: number;
  }[];
}

const classInclude = {
  classPlan: {
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
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate class ID from URL params
      eventIdSchema.parse(classId);

      // Validate request body and get typed data
      const body = validationRequestSchema.parse(await request.json());

      // Fetch class with necessary relations
      const classEntity = await prisma.class.findUnique({
        where: { id: classId },
        include: classInclude,
      });

      if (!classEntity) {
        return NextResponse.json({ error: "Class not found" }, { status: 404 });
      }

      const { classPlan } = classEntity;
      const { consultantProfile } = classPlan;

      if (!consultantProfile) {
        return NextResponse.json(
          { error: "Consultant profile not found" },
          { status: 400 },
        );
      }

      // Convert slots to Date objects
      const slotDates = body.slots.map((slot) => new Date(slot));

      // LAYER 2: Business Logic Validation (conflicts, availability, consecutive slots, weekly distribution, etc.)
      const validationService = new SlotValidationService(prisma);
      const validationResult = await validationService.validate(
        "class",
        classId,
        slotDates,
        {
          userId: consultantProfile.user.id,
          scheduleType: consultantProfile.scheduleType,
          slotsOfAvailabilityWeekly:
            consultantProfile.slotsOfAvailabilityWeekly,
          slotsOfAvailabilityCustom:
            consultantProfile.slotsOfAvailabilityCustom,
          timezone: consultantProfile.user.timezone || undefined,
        },
        {
          durationInMonths: classPlan.durationInMonths || 1,
          callsPerWeek: classPlan.callsPerWeek || 2,
          sessionDurationInHours: classPlan.sessionDurationInHours || 1,
          schedulingPeriodStartsAt:
            classEntity.schedulingPeriodStartsAt ?? undefined,
          schedulingPeriodEndsAt:
            classEntity.schedulingPeriodEndsAt ?? undefined,
        },
      );

      // If validation passed, all slots are valid
      if (validationResult.isValid) {
        return NextResponse.json({
          data: {
            conflicts: [],
            outsideAvailability: [],
            validSlots: body.slots,
            weeklyDistributionErrors: [],
          },
        });
      }

      // Parse errors to extract conflicts, availability issues, and weekly distribution
      const result: ValidationResult = {
        conflicts: [],
        outsideAvailability: [],
        validSlots: [],
        weeklyDistributionErrors: [],
      };

      for (const error of validationResult.errors) {
        if (
          error.includes("already booked") ||
          error.includes("conflicts with")
        ) {
          const slotMatch = error.match(
            /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          );
          if (slotMatch) {
            const slot = slotMatch[1];
            result.conflicts.push({
              slot,
              existingAppointment: {
                type: error.includes("Subscription")
                  ? "Subscription"
                  : error.includes("Class")
                    ? "Class"
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
          const slotMatch = error.match(
            /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          );
          if (slotMatch) {
            result.outsideAvailability.push({ slot: slotMatch[1] });
          }
        } else if (error.includes("exceeds weekly limit")) {
          // Extract week info from error message
          const weekMatch = error.match(/week of (\d{4}-\d{2}-\d{2})/);
          const countMatch = error.match(/(\d+) sessions/);
          if (weekMatch && countMatch) {
            result.weeklyDistributionErrors.push({
              week: new Date(weekMatch[1]).toLocaleDateString(),
              slotsCount: parseInt(countMatch[1]),
              maxAllowed: classPlan.callsPerWeek || 2,
            });
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

      // If there are weekly distribution errors, no slots are valid
      if (result.weeklyDistributionErrors.length > 0) {
        result.validSlots = [];
      }

      return NextResponse.json({ data: result });
    } catch (validationError) {
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = validationError.errors
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join("; ");

        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    console.error("Class validation error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to validate class slots",
      },
      { status: 500 },
    );
  }
}
