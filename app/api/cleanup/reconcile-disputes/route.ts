/**
 * Dispute Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-disputes.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcileDisputes } from "@/scripts/disputes/reconcile-disputes";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized dispute reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting dispute reconciliation via API...");

    const result = await reconcileDisputes();

    console.log("✅ Dispute reconciliation completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      urgentCount: result.urgentCount,
      razorpayManualReviewCount: result.razorpayManualReviewCount,
    });

    // Alert on urgent disputes
    if (result.urgentCount > 0) {
      console.warn(
        `⚠️ ALERT: ${result.urgentCount} disputes require immediate attention!`,
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error in dispute reconciliation:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile disputes",
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
