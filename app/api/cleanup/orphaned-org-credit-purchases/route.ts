/**
 * Orphaned Org Credit Purchase Cleanup API Endpoint
 *
 * Thin wrapper around scripts/enterprise/cleanup-orphaned-org-credit-purchases.ts.
 * Provides an HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily at 02:00 UTC (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cleanupOrphanedOrgCreditPurchases } from "@/scripts/enterprise/cleanup-orphaned-org-credit-purchases";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized orphaned purchase cleanup attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🧹 Starting orphaned org credit purchase cleanup via API...");

    const result = await cleanupOrphanedOrgCreditPurchases();

    console.log("✅ Cleanup completed:", {
      cancelledCount: result.cancelledCount,
      success: result.success,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error("Error in orphaned purchase cleanup:", error);
    return NextResponse.json(
      {
        error: "Failed to cleanup orphaned purchases",
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
