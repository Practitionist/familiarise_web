/**
 * Process Payouts API Endpoint
 *
 * FIX #620: Uses canonical lib/payments/payouts service (with distributed locking
 * and atomic transactions) instead of scripts/payouts which lacks those safety features.
 *
 * Schedule: Weekly on Mondays at 9:00 PM UTC (via GitHub Actions or external cron)
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { processApprovedPayouts } from "@/lib/payments/payouts";

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
    Sentry.logger.info("cron:process-payouts started");

    const results = await processApprovedPayouts();

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    console.log(`✅ Payout processing completed: ${succeeded} succeeded, ${failed} failed`);
    Sentry.logger.info("cron:process-payouts finished", { succeeded, failed, processed: results.length });

    return NextResponse.json({
      success: failed === 0,
      processed: results.length,
      succeeded,
      failed,
      results,
    });
  } catch (error) {
    console.error("Error in payout processing:", error);
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "process-payouts" } });
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
