/**
 * Subscription Slot Allocation API Route
 *
 * Refactored to use unified SlotAllocationService
 * Reduced from 739 lines to ~100 lines
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
import { requireApiAuth, authorizeEventAccess } from "@/lib/auth-helpers";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const startTime = Date.now();
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;

    const { subscriptionId } = await params;

    const authzError = await authorizeEventAccess(
      authResult.session,
      "subscription",
      subscriptionId,
    );
    if (authzError) return authzError;

    // LAYER 1: Zod Schema Validation (type-safe, automatic type inference)
    try {
      // Validate subscription ID from URL params
      eventIdSchema.parse(subscriptionId);
      console.log(
        `[Subscription Allocation] Starting allocation for subscription: ${subscriptionId}`,
      );

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

      console.log(
        `[Subscription Allocation] Mode: ${mode}, Slots: ${body.slots ? body.slots.length : "auto"}`,
      );

      // LAYER 2: Business Logic Validation & Allocation
      const result = await SlotAllocationService.allocate({
        eventType: "subscription",
        eventId: subscriptionId,
        mode,
        slots: body.slots,
      });

      const duration = Date.now() - startTime;
      if (!result.success) {
        console.error(
          `[Subscription Allocation] Failed after ${duration}ms: ${result.error}`,
        );
        return NextResponse.json(
          {
            error: result.error,
            details: {
              subscriptionId,
              mode,
              slotsProvided: body.slots ? body.slots.length : 0,
              duration,
            },
          },
          { status: 400 },
        );
      }

      console.log(
        `[Subscription Allocation] Success after ${duration}ms. Created ${result.appointments?.length || 0} appointment(s)`,
      );
      if (result.warnings && result.warnings.length > 0) {
        console.warn(
          `[Subscription Allocation] Warnings: ${result.warnings.join("; ")}`,
        );
      }

      return NextResponse.json({
        data: result.appointments,
        warnings: result.warnings,
      });
    } catch (validationError) {
      const duration = Date.now() - startTime;
      // Zod validation errors - return 400 Bad Request
      if (validationError instanceof ZodError) {
        const errorMessage = validationError.errors
          .map((err) => `${err.path.join(".")}: ${err.message}`)
          .join("; ");

        console.error(
          `[Subscription Allocation] Validation failed after ${duration}ms:`,
          JSON.stringify(validationError.errors, null, 2),
        );

        return NextResponse.json(
          {
            error: errorMessage,
            details: validationError.errors,
            subscriptionId,
          },
          { status: 400 },
        );
      }
      throw validationError; // Re-throw non-validation errors
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    // Catch-all for unexpected errors (database errors, network issues, etc.)
    console.error(
      `[Subscription Allocation] Error after ${duration}ms:`,
      error,
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An error occurred during slot allocation",
        duration,
      },
      { status: 500 },
    );
  }
}
