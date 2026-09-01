/**
 * Auth Token Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-auth-tokens.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily at midnight (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { cleanupAuthTokens } from "@/scripts/cleanup/cleanup-auth-tokens";
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
      console.warn("Unauthorized auth token cleanup attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("cleanup-auth-tokens");

    Sentry.logger.info("cron:cleanup-auth-tokens started");
    console.log("🧹 Starting auth token cleanup via API...");

    const result = await cleanupAuthTokens();

    console.log("✅ Auth token cleanup completed:", {
      verificationTokensDeleted: result.verificationTokensDeleted,
      sessionsDeleted: result.sessionsDeleted,
      passwordResetTokensCleared: result.passwordResetTokensCleared,
      totalCleaned: result.totalCleaned,
    });
    Sentry.logger.info("cron:cleanup-auth-tokens finished", {
      verificationTokensDeleted: result.verificationTokensDeleted,
      sessionsDeleted: result.sessionsDeleted,
      passwordResetTokensCleared: result.passwordResetTokensCleared,
      totalCleaned: result.totalCleaned,
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
      tags: { subsystem: "cron", job: "cleanup-auth-tokens" },
    });
    console.error("Error in auth token cleanup:", error);
    return NextResponse.json(
      {
        error: "Failed to cleanup auth tokens",
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
