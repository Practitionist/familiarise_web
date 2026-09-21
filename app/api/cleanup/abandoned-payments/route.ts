import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
  disconnectDatabase,
  remindApprovalPaymentsDue,
} from "@/scripts/payments/cleanup-abandoned-payments";
import {
  InvalidLimitError,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import { reportSentryError } from "@/lib/observability/report";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

function bearerMatches(authHeader: string | null, cronSecret: string): boolean {
  if (!authHeader) return false;
  const sha = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(sha(authHeader), sha(`Bearer ${cronSecret}`));
}

export async function POST(req: NextRequest) {
  try {
    // Hashed constant-time compare (matches the cleanupRoute factory): a plain
    // `!==` leaks the secret's prefix/length through response timing.
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!cronSecret || !bearerMatches(authHeader, cronSecret)) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message:
            "Please provide a valid authorization header with the CRON_SECRET",
        },
        { status: 401 },
      );
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("cleanup-abandoned-payments");

    Sentry.logger.info("cron:cleanup-abandoned-payments started");

    // `limit` is split across the three passes (not passed in full to each):
    // at `?limit=10` the old shape did up to 30 row-ops + 10 gateway cancels
    // inside one tick, sized past the ticker's 6s budget. The unbounded GitHub
    // Actions run remains the backstop that drains whatever a bounded tick
    // leaves behind (ADR 27).
    const limit = parseLimitParam(req);
    const perPass =
      limit === undefined ? undefined : Math.max(1, Math.floor(limit / 3));
    let paymentResult;
    let consultationResult;
    let reminderResult;
    try {
      paymentResult = await cleanupAbandonedPayments({ limit: perPass });
      consultationResult = await cleanupExpiredApprovalPendingPayments({
        limit: perPass,
      });
      // #1703 D2 — the half-window pay-link reminder, same lock and limit.
      reminderResult = await remindApprovalPaymentsDue({ limit: perPass });
    } finally {
      await disconnectDatabase();
    }

    Sentry.logger.info("cron:cleanup-abandoned-payments finished", {
      paymentSuccess: paymentResult.success,
      consultationSuccess: consultationResult.success,
      reminderSuccess: reminderResult.success,
    });

    const overallSuccess =
      paymentResult.success &&
      consultationResult.success &&
      reminderResult.success;
    return NextResponse.json(
      {
        paymentCleanup: paymentResult,
        consultationCleanup: consultationResult,
        paymentReminders: reminderResult,
        overallSuccess,
      },
      // #1464 — this twin always answered 200, so a run that reported failures
      // in its own body still read as healthy to the ticker and to anything
      // watching the status. The shared mapping answers 500 when the sweep
      // says it failed, which is what the rest of the cohort already does.
      { status: statusFor({ success: overallSuccess }) },
    );
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidLimitError) {
      return NextResponse.json({ error: "INVALID_LIMIT" }, { status: 400 });
    }
    if (error instanceof MaintenanceActiveError) {
      return NextResponse.json(
        { error: error.message, phase: error.phase },
        { status: error.httpStatus },
      );
    }
    // Internal-leak contract: exception text stays in Sentry/server log, never
    // echoed as `details` (Prisma fragments, gateway payloads). Matches the
    // cleanupRoute factory + #1441 plain-object rethrow handling.
    try {
      await disconnectDatabase();
    } catch {
      // Disconnect must not mask the original failure.
    }
    reportSentryError(error, {
      subsystem: "cron",
      tags: { job: "cleanup-abandoned-payments" },
    });
    console.error("Cleanup API route failed:", error);
    return NextResponse.json(
      { error: "Cleanup job failed" },
      { status: 500 },
    );
  }
}
