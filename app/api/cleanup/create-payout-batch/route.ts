/**
 * Create Payout Batch API Endpoint
 *
 * FIX #620: Uses canonical lib/payments/payouts service (with distributed locking
 * and atomic transactions) instead of scripts/payouts which lacks those safety features.
 *
 * Schedule: Weekly on Mondays at 8:00 PM UTC (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { createPayoutBatch } from "@/lib/payments/payouts";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized payout batch creation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:create-payout-batch started");
    console.log("🔄 Starting payout batch creation via API...");

    const batchId = await createPayoutBatch();

    console.log(`✅ Payout batch creation completed: ${batchId}`);
    Sentry.logger.info("cron:create-payout-batch finished", { batchId });

    return NextResponse.json({ success: true, batchId });
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "create-payout-batch" } });
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
