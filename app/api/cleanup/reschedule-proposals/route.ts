/**
 * Reschedule Proposal Expiry API Endpoint
 *
 * Thin wrapper around scripts/appointments/expire-reschedule-proposals.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { expireRescheduleProposals } from "@/scripts/appointments/expire-reschedule-proposals";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized reschedule proposal expiry attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🕐 Starting reschedule proposal expiry via API...");
    Sentry.logger.info("cron:expire-reschedule-proposals started");

    const result = await expireRescheduleProposals();

    console.log("✅ Reschedule proposal expiry completed:", {
      proposalsExpired: result.proposalsExpired,
    });
    Sentry.logger.info("cron:expire-reschedule-proposals finished", {
      proposalsExpired: result.proposalsExpired,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "expire-reschedule-proposals" },
    });
    console.error("Error in reschedule proposal expiry:", error);
    return NextResponse.json(
      {
        error: "Failed to expire reschedule proposals",
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
