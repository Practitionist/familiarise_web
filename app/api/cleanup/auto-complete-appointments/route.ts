/**
 * Auto-Complete Appointments API Endpoint
 *
 * Thin wrapper around scripts/auto-complete-appointments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { autoCompleteAppointments } from "@/scripts/appointments/auto-complete-appointments";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized auto-complete appointments attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:auto-complete-appointments started");
    console.log("⏰ Starting auto-complete appointments via API...");

    const result = await autoCompleteAppointments();

    Sentry.logger.info("cron:auto-complete-appointments finished", {
      webinarsCompleted: result.webinarsCompleted,
      classesCompleted: result.classesCompleted,
      consultationsCompleted: result.consultationsCompleted,
      subscriptionsCompleted: result.subscriptionsCompleted,
    });
    console.log("✅ Auto-complete appointments finished:", {
      webinarsCompleted: result.webinarsCompleted,
      classesCompleted: result.classesCompleted,
      consultationsCompleted: result.consultationsCompleted,
      subscriptionsCompleted: result.subscriptionsCompleted,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "auto-complete-appointments" } });
    console.error("Error in auto-complete appointments:", error);
    return NextResponse.json(
      {
        error: "Failed to auto-complete appointments",
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
