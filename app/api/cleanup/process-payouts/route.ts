/**
 * Process Payouts API Endpoint
 *
 * Thin wrapper around scripts/process-payouts.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Weekly on Mondays at 9:00 PM UTC (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { processApprovedPayouts } from "@/scripts/payouts/process-payouts";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized payout processing attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting payout processing via API...");

    const result = await processApprovedPayouts();

    console.log("✅ Payout processing completed:", {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error in payout processing:", error);
    return NextResponse.json(
      {
        error: "Failed to process payouts",
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
