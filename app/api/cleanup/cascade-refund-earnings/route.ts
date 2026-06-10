/**
 * Refund-Earning Cascade API Endpoint
 *
 * Thin wrapper around scripts/cascade-refund-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #305
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cascadeRefundToEarnings } from "@/scripts/refunds/cascade-refund-earnings";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized refund-earning cascade attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting refund-earning cascade via API...");

    const result = await cascadeRefundToEarnings();

    console.log("✅ Refund-earning cascade completed:", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });

    return NextResponse.json(result);
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error in refund-earning cascade:", error);
    return NextResponse.json(
      {
        error: "Failed to cascade refund to earnings",
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
