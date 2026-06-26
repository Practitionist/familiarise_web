/**
 * Stream User Sync API Endpoint
 *
 * Thin wrapper around scripts/stream/stream-sync.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Weekly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { performStreamUserSync } from "@/scripts/stream/stream-sync";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized stream sync attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check for dry-run query param
    const dryRun = req.nextUrl.searchParams.get("dry-run") === "true";

    Sentry.logger.info("cron:stream-sync started");
    console.log("🔄 Starting Stream user sync via API...");
    if (dryRun) {
      console.log("   Mode: DRY RUN");
    }

    const result = await performStreamUserSync({ dryRun });

    Sentry.logger.info("cron:stream-sync finished", {
      totalStreamUsersProcessed: result.totalStreamUsersProcessed,
      totalStaleUsersIdentified: result.totalStaleUsersIdentified,
      totalStaleUsersDeleted: result.totalStaleUsersDeleted,
      totalFailedDeletions: result.totalFailedDeletions,
    });
    console.log("✅ Stream user sync finished:", {
      usersProcessed: result.totalStreamUsersProcessed,
      staleIdentified: result.totalStaleUsersIdentified,
      usersDeleted: result.totalStaleUsersDeleted,
      failedDeletions: result.totalFailedDeletions,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "stream-sync" } });
    console.error("Error in stream sync:", error);
    return NextResponse.json(
      {
        error: "Failed to sync Stream users",
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
