/**
 * Consultation Slot Allocation API Route
 *
 * Refactored to use unified SlotAllocationService
 * Reduced from 590 lines to ~100 lines
 *
 * VALIDATION LAYERS:
 * 1. Zod schema validation - Type-safe validation with automatic type inference
 * 2. SlotAllocationService - Validates business rules and executes allocation
 */

import { NextRequest, NextResponse } from "next/server";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { AllocationMode } from "@/utils/slotAllocation/types";
import {
  allocationRequestSchema,
  eventIdSchema,
} from "@/schemas/slotAllocation/validationSchemas";
import { ZodError } from "zod";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate consultation ID from URL params
      eventIdSchema.parse(consultationId);

      // Validate request body and get typed data
      const body = allocationRequestSchema.parse(await request.json());

      // Determine allocation mode
      let mode: AllocationMode;
      if (body.useRequestedSlots) {
        mode = "requested";
      } else if (body.isAuto) {
        mode = "auto";
      } else {
        mode = "manual";
      }

      // LAYER 2: Business Logic Validation & Allocation
      const result = await SlotAllocationService.allocate({
        eventType: "consultation",
        eventId: consultationId,
        mode,
        slots: body.slots,
      });

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }

      return NextResponse.json({
        data: result.appointments,
        warnings: result.warnings,
      });
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
    console.error("Consultation allocation error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred during slot allocation",
      },
      { status: 500 },
    );
  }
}
