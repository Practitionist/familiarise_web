/**
 * Mark Expired Recordings Cron Job
 *
 * Marks Stream S3 recordings whose URLs have expired as EXPIRED status.
 * Prevents serving broken links to users.
 *
 * Schedule: Daily (via GitHub Actions)
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

    streamLogger.info("Starting mark-expired-recordings cron");

    const expiredCount = await RecordingTransferService.markExpiredRecordings();

    return NextResponse.json({
      success: true,
      expiredCount,
    });
  } catch (error) {
    streamLogger.error("Mark expired recordings cron failed", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
