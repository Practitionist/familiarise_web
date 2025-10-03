/**
 * Class Slot Allocation API Route
 *
 * Refactored to use unified SlotAllocationService
 * Reduced from 715 lines to ~100 lines
 */

import { NextRequest, NextResponse } from "next/server";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { AllocationMode } from "@/utils/slotAllocation/types";

interface AllocationRequest {
  isAuto: boolean;
  slots?: string[];
  useRequestedSlots?: boolean;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    const { classId } = await params;
    const body: AllocationRequest = await request.json();

    // Validate request body
    if (typeof body.isAuto !== "boolean") {
      return NextResponse.json(
        { error: "isAuto flag is required" },
        { status: 400 },
      );
    }

    // Determine allocation mode
    let mode: AllocationMode;
    if (body.useRequestedSlots) {
      mode = "requested";
    } else if (body.isAuto) {
      mode = "auto";
    } else {
      mode = "manual";
      if (!Array.isArray(body.slots) || body.slots.length === 0) {
        return NextResponse.json(
          { error: "slots array is required for manual allocation" },
          { status: 400 },
        );
      }
    }

    // Use unified allocation service
    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: classId,
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
  } catch (error) {
    console.error("Class allocation error:", error);
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
