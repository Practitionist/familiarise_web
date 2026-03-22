/**
 * Transfer Expiring Recordings Cron Job
 *
 * Auto-transfers recordings from Stream S3 to Supabase for plans with
 * SUPABASE_PERMANENT storage policy. Also identifies STREAM_ONLY
 * recordings expiring soon for consultant notification.
 *
 * Schedule: Every 6 hours (via GitHub Actions)
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { streamLogger } from "@/lib/stream-logger";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    streamLogger.info("Starting transfer-expiring-recordings cron");

    // Phase 1: Auto-transfer SUPABASE_PERMANENT recordings
    const transferResult =
      await RecordingTransferService.processExpiringRecordings(
        5, // 5 days before expiry
        10, // batch size
        "SUPABASE_PERMANENT",
      );

    // Phase 2: Find STREAM_ONLY recordings expiring soon (for notifications)
    const expiringStreamOnly =
      await RecordingTransferService.getExpiringStreamOnlyRecordings(3);

    // TODO: Send Novu notifications to consultants with expiring STREAM_ONLY recordings
    // Group by consultant and send one notification per consultant
    if (expiringStreamOnly.length > 0) {
      streamLogger.info("STREAM_ONLY recordings expiring soon", {
        count: expiringStreamOnly.length,
      });
    }

    return NextResponse.json({
      success: true,
      transferred: transferResult.succeeded,
      failed: transferResult.failed,
      expiringStreamOnly: expiringStreamOnly.length,
      errors: transferResult.errors,
    });
  } catch (error) {
    streamLogger.error("Transfer expiring recordings cron failed", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
