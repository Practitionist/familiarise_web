/**
 * Payment-Earning Sync API Endpoint
 *
 * Thin wrapper around scripts/sync-payment-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #303
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized payment-earning sync attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting payment-earning sync via API...");

    const result = await syncPaymentEarnings();

    console.log("✅ Payment-earning sync completed:", {
      totalProcessed: result.totalProcessed,
      createdCount: result.createdCount,
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
    console.error("Error in payment-earning sync:", error);
    return NextResponse.json(
      {
        error: "Failed to sync payment earnings",
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
