/**
 * Orphaned Payments Alert API Endpoint
 *
 * Thin wrapper around scripts/alert-orphaned-payments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { alertOrphanedPayments } from "@/scripts/alerts/alert-orphaned-payments";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized orphaned payments alert attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🔍 Starting orphaned payments alert via API...");

    const result = await alertOrphanedPayments();

    console.log("✅ Orphaned payments alert completed:", {
      totalOrphaned: result.totalOrphaned,
      criticalCount: result.criticalCount,
      totalAmount: result.totalAmount,
    });

    // Return 500 if orphaned payments found (to trigger alerts)
    const status = result.totalOrphaned > 0 ? 500 : 200;

    return NextResponse.json(result, { status });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error in orphaned payments alert:", error);
    return NextResponse.json(
      {
        error: "Failed to check for orphaned payments",
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
