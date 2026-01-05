/**
 * Payout Status Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-payout-status.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcilePayoutStatus } from "@/scripts/reconcile-payout-status";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized payout reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting payout status reconciliation via API...");

    const result = await reconcilePayoutStatus();

    console.log("✅ Payout reconciliation completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      completedCount: result.completedCount,
      failedCount: result.failedCount,
      discrepanciesCount: result.discrepancies.length,
    });

    // Return 207 if discrepancies found (partial success/needs attention)
    const status = result.discrepancies.length > 0 ? 207 : result.success ? 200 : 500;

    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("Error in payout reconciliation:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile payout status",
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
