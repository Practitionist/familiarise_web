/**
 * Manual Stream Sync API Route
 *
 * Triggers Stream user synchronization manually with detailed response.
 * Requires STREAM_SYNC_SECRET for authentication.
 *
 * Usage: POST /api/stream/sync/manual?secret=YOUR_SECRET
 */

import { NextResponse } from "next/server";
import { performStreamUserSync, SyncSummary } from "@/jobs/stream-sync";
import { streamLogger } from "@/lib/stream-logger";

export async function POST(request: Request) {
  // Security check
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");

  if (secret !== process.env.STREAM_SYNC_SECRET) {
    streamLogger.warn("Unauthorized manual sync attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  streamLogger.info("Manual sync triggered via API");

  // Check for dry-run mode
  const dryRun = searchParams.get("dryRun") === "true";

  try {
    const startTime = Date.now();
    const summary: SyncSummary = await performStreamUserSync({ dryRun });
    const duration = Date.now() - startTime;

    streamLogger.info("Manual sync completed", {
      durationMs: duration,
      usersProcessed: summary.totalStreamUsersProcessed,
      usersDeleted: summary.totalStaleUsersDeleted,
    });

    return NextResponse.json(
      {
        message: dryRun
          ? "Stream sync dry run completed"
          : "Stream user synchronization completed",
        dryRun,
        durationMs: duration,
        summary: {
          totalStreamUsersProcessed: summary.totalStreamUsersProcessed,
          staleUsersIdentified: summary.totalStaleUsersIdentified,
          staleUsersDeleted: summary.totalStaleUsersDeleted,
          failedDeletions: summary.totalFailedDeletions,
        },
        ...(summary.failedDeletionDetails.length > 0 && {
          failedDeletionDetails: summary.failedDeletionDetails,
        }),
      },
      { status: 200 },
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    streamLogger.error("Manual sync failed", error);

    return NextResponse.json(
      {
        error: "Sync failed",
        details: errorMessage,
      },
      { status: 500 },
    );
  }
}
