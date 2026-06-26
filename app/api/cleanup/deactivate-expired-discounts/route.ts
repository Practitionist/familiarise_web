/**
 * Deactivate Expired Discounts API Endpoint
 *
 * Thin wrapper around scripts/deactivate-expired-discounts.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily at midnight (via GitHub Actions or external cron)
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { deactivateExpiredDiscounts } from "@/scripts/cleanup/deactivate-expired-discounts";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized discount deactivation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:deactivate-expired-discounts started");
    console.log("🏷️ Starting expired discount deactivation via API...");

    const result = await deactivateExpiredDiscounts();

    console.log("✅ Expired discount deactivation completed:", {
      expiredByDateCount: result.expiredByDateCount,
      maxUsesReachedCount: result.maxUsesReachedCount,
      totalDeactivated: result.totalDeactivated,
    });
    Sentry.logger.info("cron:deactivate-expired-discounts finished", {
      expiredByDateCount: result.expiredByDateCount,
      maxUsesReachedCount: result.maxUsesReachedCount,
      totalDeactivated: result.totalDeactivated,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "deactivate-expired-discounts" } });
    console.error("Error in discount deactivation:", error);
    return NextResponse.json(
      {
        error: "Failed to deactivate expired discounts",
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
