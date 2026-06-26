/**
 * Auto-Complete Trial Sessions Cleanup Endpoint
 *
 * Marks SCHEDULED trial sessions as COMPLETED when their appointment end time has passed.
 * Previously this mutation ran inside GET /api/trials (a side-effect in a read operation).
 * Moved here so state transitions happen on a predictable schedule, not on user requests.
 *
 * Schedule: Hourly (via GitHub Actions or external cron — add to the same job as
 *           auto-complete-appointments if timing requirements are similar)
 */

import { NextRequest, NextResponse } from "next/server";
import { TrialSessionStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized auto-complete-trials attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();

    Sentry.logger.info("cron:auto-complete-trials started");

    // #476 — entry-level cron lock; fail-open (idempotent updateMany).
    const result = await withCronLock(
      "auto-complete-trials",
      { failMode: "open" },
      async () => {
        return prisma.trialSession.updateMany({
          where: {
            status: TrialSessionStatus.SCHEDULED,
            appointment: {
              slotsOfAppointment: {
                some: {
                  endsAt: { lt: now },
                },
              },
            },
          },
          data: {
            status: TrialSessionStatus.COMPLETED,
            completedAt: now,
          },
        });
      },
    );

    console.log(
      JSON.stringify({
        event: "auto_complete_trials",
        completedCount: result.count,
        timestamp: now.toISOString(),
      }),
    );

    Sentry.logger.info("cron:auto-complete-trials finished", { trialsCompleted: result.count });

    return NextResponse.json({
      success: true,
      trialsCompleted: result.count,
    });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "auto-complete-trials" } });
    console.error("Error in auto-complete-trials cleanup:", error);
    return NextResponse.json(
      { success: false, error: "Failed to auto-complete trial sessions" },
      { status: 500 },
    );
  }
}
