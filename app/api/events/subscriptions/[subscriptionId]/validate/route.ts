/**
 * Subscription Slot Validation API Route
 *
 * Refactored to use unified SlotValidationService + SubscriptionValidationService
 * Reduced from 240 lines to ~100 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SlotValidationService - Validates business rules (conflicts, availability, etc.)
 * 3. SubscriptionValidationService - Validates subscription-specific rules (weekly limits, etc.)
 */

import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import { SubscriptionValidationService } from "@/utils/subscriptionValidation";
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

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate subscription ID from URL params
      eventIdSchema.parse(subscriptionId);

      // Validate request body and get typed data
      const body = validationRequestSchema.parse(await request.json());

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

    // Convert slots to Date objects
    const slotDates = body.slots.map((slot) => new Date(slot));

    // LAYER 2: Business Logic Validation (conflicts, availability, consecutive slots, etc.)
    const validationService = new SlotValidationService(prisma);
    const validationResult = await validationService.validate(
      "subscription",
      subscriptionId,
      slotDates,
      {
        userId: consultantProfile.user.id,
        scheduleType: consultantProfile.scheduleType,
        slotsOfAvailabilityWeekly: consultantProfile.slotsOfAvailabilityWeekly,
        slotsOfAvailabilityCustom: consultantProfile.slotsOfAvailabilityCustom,
        currentTimezone: consultantProfile.user.currentTimezone || undefined,
      },
      {
        durationInMonths: subscriptionPlan.durationInMonths,
        callsPerWeek: subscriptionPlan.callsPerWeek,
        sessionDurationInHours: subscriptionPlan.sessionDurationInHours,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
      },
    );

    // LAYER 3: Subscription-Specific Validation (weekly limits, total calls, etc.)
    const subscriptionValidationService = new SubscriptionValidationService(
      prisma,
    );
    const subscriptionValidation =
      await subscriptionValidationService.validateSubscriptionSlots(
        subscriptionId,
        body.slots,
      );

    // Build response
    const result: ValidationResult = {
      conflicts: [],
      outsideAvailability: [],
      validSlots: validationResult.isValid ? body.slots : [],
      subscriptionValidation,
    };

    // Parse errors if validation failed
    if (!validationResult.isValid) {
      for (const error of validationResult.errors) {
        if (
          error.includes("already booked") ||
          error.includes("conflicts with")
        ) {
          const slotMatch = error.match(
            /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
          );
          if (slotMatch) {
            result.conflicts.push({
              slot: slotMatch[1],
              existingAppointment: {
                type: error.includes("Subscription")
                  ? "Subscription"
                  : "Consultation",
                with: "Another user",
                time: new Date(slotMatch[1]).toLocaleString(),
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
        }
      }

      // Filter valid slots
      result.validSlots = body.slots.filter((slot) => {
        return (
          !result.conflicts.some((c) => c.slot === slot) &&
          !result.outsideAvailability.some((o) => o.slot === slot)
        );
      });
    }

    // If subscription validation fails, no slots are valid
      if (!subscriptionValidation.isValid) {
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
    console.error("Validation error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to validate slots",
      },
      { status: 500 },
    );
  }
}
