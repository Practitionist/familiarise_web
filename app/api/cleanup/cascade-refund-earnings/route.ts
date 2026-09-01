/**
 * Refund-Earning Cascade API Endpoint
 *
 * Thin wrapper around scripts/cascade-refund-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #305
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cascadeRefundToEarnings } from "@/scripts/refunds/cascade-refund-earnings";
import { cascadeRunFailed } from "@/scripts/refunds/cascade-run-outcome";
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
      console.warn("Unauthorized refund-earning cascade attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("cascade-refund-earnings");

    Sentry.logger.info("cron:cascade-refund-earnings started");
    console.log("🔄 Starting refund-earning cascade via API...");

    const result = await cascadeRefundToEarnings();

    Sentry.logger.info("cron:cascade-refund-earnings finished", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });
    console.log("✅ Refund-earning cascade completed:", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });

    // PM-34 — result.success === false means some SUCCEEDED refunds failed
    // their cascade; an unconditional 200 told the cron's health check
    // everything was fine and it never paged. Mirror the other money crons
    // (e.g. appointment-reminders) with a 500 on a failed run.
    return NextResponse.json(result, {
      status: cascadeRunFailed(result) ? 500 : 200,
    });
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
      tags: { subsystem: "cron", job: "cascade-refund-earnings" },
    });
    console.error("Error in refund-earning cascade:", error);
    return NextResponse.json(
      {
        error: "Failed to cascade refund to earnings",
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
