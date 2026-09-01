/**
 * Tentative Slot Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-tentative-slots.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 2 hours (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cleanupTentativeSlots } from "@/scripts/appointments/cleanup-tentative-slots";
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
      console.warn("Unauthorized tentative slot cleanup attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("cleanup-tentative-slots");

    console.log("🧹 Starting tentative slot cleanup via API...");
    Sentry.logger.info("cron:cleanup-tentative-slots started");

    const result = await cleanupTentativeSlots();

    console.log("✅ Tentative slot cleanup completed:", {
      slotsReleased: result.slotsReleased,
      appointmentsAffected: result.appointmentsAffected,
    });
    Sentry.logger.info("cron:cleanup-tentative-slots finished", {
      slotsReleased: result.slotsReleased,
      appointmentsAffected: result.appointmentsAffected,
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
      tags: { subsystem: "cron", job: "cleanup-tentative-slots" },
    });
    console.error("Error in tentative slot cleanup:", error);
    return NextResponse.json(
      {
        error: "Failed to cleanup tentative slots",
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
