/**
 * POST /api/cleanup/abandoned-org-top-ups
 *
 * Enterprise sibling of `/api/cleanup/abandoned-payments`. Reaps pending
 * `WalletEntry` placeholder rows that never received a webhook confirmation
 * within the grace window. See scripts/cleanup/cleanup-abandoned-org-top-ups.ts
 * for the full invariant + rationale.
 *
 * This route is a thin wrapper around the shared script so the same code
 * runs in both the GitHub Actions job (jobs/cleanup/cleanup-abandoned-org-top-ups.ts)
 * and the on-demand HTTP endpoint, matching the rest of /api/cleanup/*.
 *
 * Gated by CRON_SECRET (or VERCEL_CRON_SECRET) just like every other
 * cleanup route — the Authorization header must carry the bearer token.
 */

import { NextResponse, type NextRequest } from "next/server";
import { cleanupAbandonedOrgTopUps } from "@/scripts/cleanup/cleanup-abandoned-org-top-ups";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn("Unauthorized abandoned-org-top-ups cleanup attempt");
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
    console.log("🧹 Starting abandoned org top-up cleanup via API...");
    const result = await cleanupAbandonedOrgTopUps();

    console.log("✅ Abandoned org top-up cleanup completed:", {
      reaped: result.reaped,
      graceHours: result.graceHours,
      success: result.success,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[cleanup/abandoned-org-top-ups] failed:", error);
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
