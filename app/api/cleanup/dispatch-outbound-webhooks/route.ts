/**
 * POST /api/cleanup/dispatch-outbound-webhooks
 *
 * Cron tick for the outbound webhook delivery worker. Gated by
 * `CRON_SECRET` like every other route under /api/cleanup — the worker
 * itself is idempotent so a casual extra invocation is harmless, but
 * the bearer gate keeps random callers from running it.
 */

import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";
import { NextResponse, type NextRequest } from "next/server";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  dispatchOutboundWebhooks,
  disconnectDatabase,
} from "@/scripts/cleanup/dispatch-outbound-webhooks";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        message: "Provide a valid Bearer CRON_SECRET",
      },
      { status: 401 },
    );
  }

  try {
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("dispatch-outbound-webhooks");
    Sentry.logger.info("cron:dispatch-outbound-webhooks started");
    const result = await dispatchOutboundWebhooks();
    Sentry.logger.info("cron:dispatch-outbound-webhooks finished", {
      scanned: result.scanned,
      succeeded: result.succeeded,
      retried: result.retried,
      failed: result.failed,
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
      tags: { subsystem: "cron", job: "dispatch-outbound-webhooks" },
    });
    console.error("[cleanup/dispatch-outbound-webhooks] failed:", error);
    return NextResponse.json(
      {
        error: "Dispatch tick failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  } finally {
    // The HTTP route does NOT disconnect — `prisma` is the global
    // singleton shared with the rest of the Next runtime. We only
    // disconnect in the standalone job wrapper (jobs/cleanup/*).
    void disconnectDatabase;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
