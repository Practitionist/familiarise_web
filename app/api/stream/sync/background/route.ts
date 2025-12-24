/**
 * Background Stream Sync API Route
 *
 * Designed for Vercel Cron Jobs or external schedulers.
 * Triggers Stream user synchronization in background.
 *
 * Vercel Cron: Add to vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/stream/sync/background?secret=YOUR_SECRET",
 *     "schedule": "0 3 * * *"  // Daily at 3 AM
 *   }]
 * }
 */

import { NextResponse } from "next/server";
import { performStreamUserSync, SyncSummary } from "@/jobs/stream-sync";
import { streamLogger } from "@/lib/stream-logger";

export async function POST(request: Request) {
  // Security check
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");

  if (secret !== process.env.STREAM_SYNC_SECRET) {
    streamLogger.warn("Unauthorized background sync attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  streamLogger.info("Background sync triggered");

  try {
    const startTime = Date.now();
    const summary: SyncSummary = await performStreamUserSync();
    const duration = Date.now() - startTime;

    streamLogger.info("Background sync completed", {
      durationMs: duration,
      usersProcessed: summary.totalStreamUsersProcessed,
      usersDeleted: summary.totalStaleUsersDeleted,
    });

    // Return minimal response for cron job
    return NextResponse.json(
      {
        success: true,
        message: "Background sync completed",
        durationMs: duration,
        stats: {
          processed: summary.totalStreamUsersProcessed,
          identified: summary.totalStaleUsersIdentified,
          deleted: summary.totalStaleUsersDeleted,
          failed: summary.totalFailedDeletions,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    streamLogger.error("Background sync failed", error);

    // Return error for cron job monitoring
    return NextResponse.json(
      {
        success: false,
        error: "Background sync failed",
        details: errorMessage,
      },
      { status: 500 },
    );
  }
}

// Also support GET for Vercel Cron
export async function GET(request: Request) {
  return POST(request);
}
