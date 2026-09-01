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
      console.warn("Unauthorized lost dispute handler attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("handle-lost-disputes");

    console.log("🔄 Starting lost dispute handler via API...");
    Sentry.logger.info("cron:handle-lost-disputes started");

    const result = await handleLostDisputes();

    console.log("✅ Lost dispute handler completed:", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      alreadyPaidCount: result.alreadyPaidCount,
      errorCount: result.errorCount,
    });
    Sentry.logger.info("cron:handle-lost-disputes finished", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      alreadyPaidCount: result.alreadyPaidCount,
      errorCount: result.errorCount,
    });

    // Return appropriate status based on critical cases
    const status =
      result.alreadyPaidCount > 0 ? 207 : result.success ? 200 : 500;

    return NextResponse.json(result, { status });
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
    console.error("Error in lost dispute handler:", error);
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "handle-lost-disputes" },
    });
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
