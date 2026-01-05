/**
 * Stale Pending Consultations Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-stale-pending-consultations.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cleanupStalePendingConsultations } from "@/scripts/appointments/cleanup-stale-pending-consultations";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized stale consultation cleanup attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🧹 Starting stale pending consultations cleanup via API...");

    const result = await cleanupStalePendingConsultations();

    console.log("✅ Stale pending consultations cleanup completed:", {
      consultationsCancelled: result.consultationsCancelled,
      slotsReleased: result.slotsReleased,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error("Error in stale consultation cleanup:", error);
    return NextResponse.json(
      {
        error: "Failed to cleanup stale pending consultations",
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
