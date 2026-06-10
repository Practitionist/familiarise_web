/**
 * Refund Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-pending-refunds.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized refund reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting refund reconciliation via API...");

    const result = await reconcilePendingRefunds();

    console.log("✅ Refund reconciliation completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });

    return NextResponse.json(result);
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error in refund reconciliation:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile refunds",
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
