/**
 * Slot Availability Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-slot-availability.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcileSlotAvailability } from "@/scripts/appointments/reconcile-slot-availability";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized slot reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting slot availability reconciliation via API...");

    const result = await reconcileSlotAvailability();

    console.log("✅ Slot availability reconciliation completed:", {
      tentativeFlagsCleared: result.tentativeFlagsCleared,
      doubleBookingsDetected: result.doubleBookingsDetected,
    });

    // Return 207 if double bookings detected (needs attention)
    // Return 500 if errors occurred
    const status = result.doubleBookingsDetected > 0 ? 207 : result.success ? 200 : 500;

    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("Error in slot reconciliation:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile slot availability",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Also support POST for manual triggering
export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
