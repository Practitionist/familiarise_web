/**
 * Stale Pending Consultations Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-stale-pending-consultations.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cleanupStalePendingConsultations } from "@/scripts/appointments/cleanup-stale-pending-consultations";
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
      console.warn("Unauthorized stale consultation cleanup attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("cleanup-stale-pending-consultations");

    Sentry.logger.info("cron:cleanup-stale-pending-consultations started");
    console.log("🧹 Starting stale pending consultations cleanup via API...");

    const result = await cleanupStalePendingConsultations();

    console.log("✅ Stale pending consultations cleanup completed:", {
      consultationsCancelled: result.consultationsCancelled,
      slotsReleased: result.slotsReleased,
    });
    Sentry.logger.info("cron:cleanup-stale-pending-consultations finished", {
      consultationsCancelled: result.consultationsCancelled,
      slotsReleased: result.slotsReleased,
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
      tags: { subsystem: "cron", job: "cleanup-stale-pending-consultations" },
    });
    console.error("Error in stale consultation cleanup:", error);
    return NextResponse.json(
      {
        error: "Failed to cleanup stale pending consultations",
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
