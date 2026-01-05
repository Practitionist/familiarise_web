/**
 * Lost Dispute Handler API Endpoint
 *
 * Thin wrapper around scripts/handle-lost-disputes.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #304
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { handleLostDisputes } from "@/scripts/disputes/handle-lost-disputes";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized lost dispute handler attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔄 Starting lost dispute handler via API...");

    const result = await handleLostDisputes();

    console.log("✅ Lost dispute handler completed:", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      alreadyPaidCount: result.alreadyPaidCount,
      errorCount: result.errorCount,
    });

    // Return appropriate status based on critical cases
    const status = result.alreadyPaidCount > 0 ? 207 : result.success ? 200 : 500;

    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("Error in lost dispute handler:", error);
    return NextResponse.json(
      {
        error: "Failed to handle lost disputes",
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
