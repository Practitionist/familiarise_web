/**
 * Create Payout Batch API Endpoint
 *
 * Thin wrapper around scripts/create-payout-batch.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Weekly on Mondays at 8:00 PM UTC (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { createPayoutBatch } from "@/scripts/create-payout-batch";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized payout batch creation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting payout batch creation via API...");

    const result = await createPayoutBatch();

    console.log("✅ Payout batch creation completed:", {
      batchId: result.batchId,
      payoutsCreated: result.payoutsCreated,
      totalAmount: result.totalAmount,
      autoApproved: result.autoApproved,
      pendingApproval: result.pendingApproval,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error in payout batch creation:", error);
    return NextResponse.json(
      {
        error: "Failed to create payout batch",
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
