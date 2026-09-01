/**
 * Dispute Deadline Alerts API Endpoint
 *
 * Thin wrapper around scripts/alert-dispute-deadlines.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { alertDisputeDeadlines } from "@/scripts/disputes/alert-dispute-deadlines";
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
      console.warn("Unauthorized dispute deadline alert attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("alert-dispute-deadlines");

    console.log("🔔 Checking dispute deadlines via API...");
    Sentry.logger.info("cron:alert-dispute-deadlines started");

    const result = await alertDisputeDeadlines();

    console.log("✅ Dispute deadline check completed:", {
      urgentCount: result.urgentCount,
      criticalCount: result.criticalCount,
    });
    Sentry.logger.info("cron:alert-dispute-deadlines finished", {
      urgentCount: result.urgentCount,
      criticalCount: result.criticalCount,
    });

    // Return 207 if critical disputes found (needs immediate attention)
    const status = result.criticalCount > 0 ? 207 : 200;

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
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "alert-dispute-deadlines" },
    });
    console.error("Error checking dispute deadlines:", error);
    return NextResponse.json(
      {
        error: "Failed to check dispute deadlines",
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
