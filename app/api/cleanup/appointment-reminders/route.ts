/**
 * Appointment Reminders API Endpoint
 *
 * Thin wrapper around scripts/send-appointment-reminders.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { sendAppointmentReminders } from "@/scripts/appointments/send-appointment-reminders";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized appointment reminders attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:appointment-reminders started");
    console.log("⏰ Starting appointment reminders via API...");

    const result = await sendAppointmentReminders();

    Sentry.logger.info("cron:appointment-reminders finished", {
      reminders24h: result.reminders24h,
      reminders1h: result.reminders1h,
    });
    console.log("✅ Appointment reminders finished:", {
      reminders24h: result.reminders24h,
      reminders1h: result.reminders1h,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "appointment-reminders" } });
    console.error("Error in appointment reminders:", error);
    return NextResponse.json(
      {
        error: "Failed to send appointment reminders",
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
