import { NextRequest, NextResponse } from "next/server";
import { cleanupTentativeSlots } from "@/scripts/appointments/cleanup-tentative-slots";
import { acquireLock, releaseLock } from "@/lib/redis";

export async function GET(req: NextRequest): Promise<NextResponse> {
  let lockToken: string | null = null;
  const LOCK_KEY = "lock:cleanup:tentative-slots";
  const LOCK_TTL = 10 * 60 * 1000; // 10 minutes

  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Phase 2: Distributed locking for cron jobs (Issue #476)
    lockToken = await acquireLock(LOCK_KEY, LOCK_TTL);
    if (!lockToken) {
      console.log("Cleanup already in progress, skipping...");
      return NextResponse.json({ message: "Already in progress" }, { status: 409 });
    }

    console.log("🧹 Starting tentative slot cleanup via API...");
    const result = await cleanupTentativeSlots();

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error("Error in tentative slot cleanup:", error);
    return NextResponse.json({ error: "Failed to cleanup" }, { status: 500 });
  } finally {
    if (lockToken) {
      await releaseLock(LOCK_KEY, lockToken);
    }
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
