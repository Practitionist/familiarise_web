/**
 * POST /api/cleanup/stale-invitations
 *
 * HTTP companion to `jobs/cleanup/cleanup-stale-invitations.ts`. Lets
 * an operator run the cleanup on-demand (e.g. after bulk-inviting a
 * stale email list) without waiting for the scheduled 02:30 UTC slot.
 *
 * Gated by CRON_SECRET (or VERCEL_CRON_SECRET) — identical pattern to
 * every other `/api/cleanup/*` route.
 */

import { NextResponse, type NextRequest } from "next/server";
import { cleanupStaleInvitations } from "@/scripts/cleanup/cleanup-stale-invitations";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn("Unauthorized stale-invitations cleanup attempt");
    return NextResponse.json(
      {
        error: "Unauthorized",
        message:
          "Please provide a valid authorization header with the CRON_SECRET",
      },
      { status: 401 },
    );
  }

  try {
    Sentry.logger.info("cron:cleanup-stale-invitations started");
    const result = await cleanupStaleInvitations();

    console.log("✅ Stale invitation cleanup completed:", {
      expired: result.expired,
      success: result.success,
    });

    Sentry.logger.info("cron:cleanup-stale-invitations finished", {
      expired: result.expired,
      success: result.success,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "cleanup-stale-invitations" },
    });
    console.error("[cleanup/stale-invitations] failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Some external schedulers (e.g. legacy Vercel Cron) only emit GET.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
