/**
 * Stuck Payouts Handler API Endpoint
 *
 * Thin wrapper around scripts/handle-stuck-payouts.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 4 hours (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { handleStuckPayouts } from "@/scripts/payouts/handle-stuck-payouts";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized stuck payouts handler attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("handle-stuck-payouts");

    Sentry.logger.info("cron:handle-stuck-payouts started");
    console.log("🔄 Starting stuck payouts handler via API...");

    const result = await handleStuckPayouts();

    console.log("✅ Stuck payouts handler completed:", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      retriedCount: result.retriedCount,
      failedCount: result.failedCount,
    });
    Sentry.logger.info("cron:handle-stuck-payouts finished", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      retriedCount: result.retriedCount,
      failedCount: result.failedCount,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MaintenanceActiveError) {
      return NextResponse.json(
        { error: error.message, phase: error.phase },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "handle-stuck-payouts" },
    });
    console.error("Error in stuck payouts handler:", error);
    return NextResponse.json(
      {
        error: "Failed to handle stuck payouts",
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
