/**
 * Payment Status Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-payment-status.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 30 minutes (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcilePaymentStatus } from "@/scripts/reconcile-payment-status";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized payment reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting payment status reconciliation via API...");

    const result = await reconcilePaymentStatus();

    console.log("✅ Payment reconciliation completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      succeededCount: result.succeededCount,
      failedCount: result.failedCount,
    });

    // Return 207 if succeeded payments found (needs attention)
    const status = result.succeededCount > 0 ? 207 : result.success ? 200 : 500;

    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("Error in payment reconciliation:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile payment status",
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
